#!/usr/bin/env python3 -u
"""CMA-ES optimizer for Beckett painting parameters.

Main loop:
  Python writes params.json → Playwright paints → Python scores PNG → CMA-ES updates

Usage:
  python tools/cma_optimize.py --reference-dir test/clarice/reference --generations 150
  python tools/cma_optimize.py --resume checkpoints/cma-gen-50.pkl
"""

import argparse
import json
import os
import subprocess
import sys
import time
import pickle
import glob
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

try:
    import cma
except ImportError:
    print("ERROR: pip install cma (CMA-ES optimizer)")
    sys.exit(1)

# Import the scorer
sys.path.insert(0, os.path.dirname(__file__))
from beckett_critic import score_candidate, build_reference_distribution

# --- Parameter vector definition (47 params) ---

PARAM_NAMES = [
    # Group A: Conductor (0-6)
    'restraint', 'focalDensity', 'veilStrength', 'bareCanvasThreshold',
    'darkSoftening', 'accentTiming', 'interRegionBleed',
    # Group B: Composition modifiers (7-10)
    'sparse_composition_mult', 'atmospheric_emphasis', 'focal_emphasis', 'dark_commitment',
    # Group C: Brush params by depth (11-16)
    'thinners_far', 'load_far', 'thinners_mid', 'load_mid', 'thinners_near', 'load_near',
    # Group D: Layer budget (17-21)
    'budget_atmosphere', 'budget_background', 'budget_midtones', 'budget_darkForms', 'budget_accents',
    # Group E: Global painting (22-24)
    'total_stroke_base', 'strokes_per_region', 'pressure_global_scale',
    # Group F: Recipe tuning (25-46)
    'wash_spacing_mult', 'wash_passes', 'tree_wash_load', 'tree_mel_shift',
    'tree_dab_count_scale', 'building_load_mult', 'pole_load_mult',
    'trunk_curve', 'trunk_branch_prob', 'figure_load_mult', 'figure_passes',
    'umbrella_spoke_count', 'boat_hull_length', 'boat_mast_height',
    'reflection_opacity', 'reflection_smear', 'lightdot_size', 'lightdot_brightness',
    'wave_spacing', 'wave_load', 'headland_edge_rough', 'mass_mel_shift',
]

# Ranges: (min, max) for each parameter
PARAM_RANGES = [
    # Group A
    (0.4, 1.0), (1.0, 3.0), (0.0, 1.0), (0.0, 0.4),
    (0.0, 0.6), (0.3, 1.0), (0.1, 0.8),
    # Group B
    (0.6, 1.4), (0.5, 2.0), (0.8, 2.5), (0.0, 1.0),
    # Group C
    (0.10, 0.60), (0.10, 0.45), (0.02, 0.35), (0.20, 0.65), (0.00, 0.20), (0.30, 0.85),
    # Group D
    (0.08, 0.30), (0.10, 0.35), (0.08, 0.30), (0.08, 0.25), (0.02, 0.15),
    # Group E
    (800, 2400), (5, 25), (0.6, 1.4),
    # Group F
    (0.10, 0.40), (1, 3), (0.10, 0.40), (0, 3),
    (0.3, 1.5), (0.4, 1.0), (0.3, 0.9),
    (0.005, 0.03), (0.0, 0.5), (0.4, 1.0), (2, 6),
    (3, 8), (0.02, 0.08), (0.03, 0.10),
    (0.10, 0.40), (0.5, 2.0), (0.005, 0.02), (0, 2),
    (0.01, 0.05), (0.3, 0.8), (0.005, 0.03), (0, 2),
]

# Warm-start defaults — CMA-ES gen 10, score 0.4439
DEFAULT_VECTOR = [
    # Group A: conductor
    0.82, 1.59, 0.79, 0.39, 0.14, 0.44, 0.17,
    # Group B: composition modifiers
    0.67, 0.51, 2.43, 0.18,
    # Group C: depth thinners/load (far, mid, near)
    0.20, 0.29, 0.11, 0.43, 0.04, 0.63,
    # Group D: layer budgets
    0.12, 0.34, 0.24, 0.15, 0.14,
    # Group E: global
    1798, 9, 1.06,
    # Group F: recipes
    0.10, 2, 0.33, 3,
    1.13, 0.92, 0.70,
    0.010, 0.50, 0.90, 4,
    6, 0.025, 0.047,
    0.40, 1.94, 0.005, 1,
    0.027, 0.64, 0.029, 0,
]

assert len(PARAM_NAMES) == 47
assert len(PARAM_RANGES) == 47
assert len(DEFAULT_VECTOR) == 47


def clamp_vector(vec: list[float]) -> list[float]:
    """Clamp each parameter to its valid range."""
    return [
        max(lo, min(hi, v))
        for v, (lo, hi) in zip(vec, PARAM_RANGES)
    ]


def compute_sigma0() -> list[float]:
    """Initial step sizes — 20% of each parameter's range."""
    return [(hi - lo) * 0.2 for lo, hi in PARAM_RANGES]


def evaluate_single(
    vec: list[float],
    ref_name: str,
    worker_id: int,
    reference_dist: dict,
    project_root: str,
) -> float:
    """Evaluate a single parameter vector against one reference image.
    Returns negative score (CMA-ES minimizes)."""
    vec = clamp_vector(vec)

    # Worker-specific output directory
    work_dir = os.path.join(project_root, f'test/output/cma/worker-{worker_id}')
    os.makedirs(work_dir, exist_ok=True)

    params_path = os.path.join(work_dir, 'params.json')
    candidate_path = os.path.join(work_dir, 'candidate.png')

    # Write params.json for Playwright
    with open(params_path, 'w') as f:
        json.dump({'vector': vec, 'reference': ref_name}, f)

    # Remove old candidate
    if os.path.exists(candidate_path):
        os.remove(candidate_path)

    # Run Playwright painting spec
    env = {**os.environ, 'CHROME': '1', 'CMA_WORK_DIR': work_dir}
    try:
        result = subprocess.run(
            [
                'npx', 'playwright', 'test',
                'test/clarice/cma-painting.spec.ts',
                '--project=clarice',
                '--reporter=dot',
            ],
            cwd=project_root,
            env=env,
            capture_output=True,
            text=True,
            timeout=360,
        )
    except subprocess.TimeoutExpired:
        print(f'  [worker-{worker_id}] Playwright timeout')
        return 0.0  # worst score (negated below)

    if not os.path.exists(candidate_path):
        print(f'  [worker-{worker_id}] No candidate.png produced')
        return 0.0

    # Score the candidate
    try:
        score = score_candidate(candidate_path, reference_dist)
    except Exception as e:
        print(f'  [worker-{worker_id}] Scoring failed: {e}', flush=True)
        return 0.0

    print(f'  [worker-{worker_id}] score={score:.4f} strokes={ref_name}', flush=True)
    return score


def evaluate_multi_ref(
    vec: list[float],
    ref_names: list[str],
    worker_id: int,
    reference_dist: dict,
    project_root: str,
) -> float:
    """Average score across multiple reference images."""
    scores = []
    for ref_name in ref_names:
        s = evaluate_single(vec, ref_name, worker_id, reference_dist, project_root)
        scores.append(s)
    return sum(scores) / len(scores) if scores else 0.0


def select_diverse_references(ref_dir: str, count: int = 5) -> list[str]:
    """Select a diverse subset of reference images for evaluation."""
    all_refs = []
    for ext in ('*.jpg', '*.jpeg', '*.png', '*.webp'):
        all_refs.extend(glob.glob(os.path.join(ref_dir, ext)))
    all_refs.sort()

    if len(all_refs) <= count:
        return [os.path.basename(r) for r in all_refs]

    # Evenly spaced selection for diversity
    indices = np.linspace(0, len(all_refs) - 1, count, dtype=int)
    return [os.path.basename(all_refs[i]) for i in indices]


def run_optimization(args):
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    ref_dir = os.path.join(project_root, args.reference_dir)
    checkpoint_dir = os.path.join(project_root, 'tools/checkpoints')
    os.makedirs(checkpoint_dir, exist_ok=True)

    # Build or load reference distribution
    ref_dist_path = os.path.join(project_root, 'tools/beckett-reference.json')
    if os.path.exists(ref_dist_path):
        print(f'Loading reference distribution from {ref_dist_path}')
        with open(ref_dist_path) as f:
            reference_dist = json.load(f)
    else:
        print(f'Building reference distribution from {ref_dir}...')
        all_refs = []
        for ext in ('*.jpg', '*.jpeg', '*.png', '*.webp'):
            all_refs.extend(glob.glob(os.path.join(ref_dir, ext)))
        reference_dist = build_reference_distribution(all_refs)
        with open(ref_dist_path, 'w') as f:
            json.dump(reference_dist, f)
        print(f'Saved to {ref_dist_path}')

    # Select evaluation references
    eval_refs = select_diverse_references(ref_dir, args.eval_refs)
    print(f'Evaluating on {len(eval_refs)} references: {eval_refs}', flush=True)

    # Resume or start fresh
    if args.resume:
        print(f'Resuming from {args.resume}')
        with open(args.resume, 'rb') as f:
            state = pickle.load(f)
        es = state['es']
        best_score = state.get('best_score', 0)
        best_vec = state.get('best_vec', DEFAULT_VECTOR)
        gen_start = state.get('generation', 0) + 1
    else:
        sigma0 = np.mean(compute_sigma0())
        bounds = list(zip(*PARAM_RANGES))
        es = cma.CMAEvolutionStrategy(
            DEFAULT_VECTOR,
            sigma0,
            {
                'popsize': args.popsize,
                'bounds': bounds,
                'seed': args.seed,
                'maxiter': args.generations,
                'verbose': 1,
            },
        )
        best_score = 0
        best_vec = DEFAULT_VECTOR[:]
        gen_start = 0

    print(f'\nCMA-ES: popsize={args.popsize}, generations={args.generations}', flush=True)
    print(f'Vector dimension: {len(DEFAULT_VECTOR)}\n', flush=True)

    for gen in range(gen_start, args.generations):
        solutions = es.ask()
        fitnesses = []

        t0 = time.time()

        if args.workers > 1:
            # Parallel evaluation
            with ProcessPoolExecutor(max_workers=args.workers) as pool:
                futures = {}
                for i, sol in enumerate(solutions):
                    f = pool.submit(
                        evaluate_multi_ref,
                        list(sol), eval_refs, i, reference_dist, project_root,
                    )
                    futures[f] = i

                results = [0.0] * len(solutions)
                for f in as_completed(futures):
                    idx = futures[f]
                    try:
                        results[idx] = f.result()
                    except Exception as e:
                        print(f'  Worker {idx} failed: {e}')
                        results[idx] = 0.0

                fitnesses = [-s for s in results]  # CMA-ES minimizes
        else:
            # Sequential evaluation
            for i, sol in enumerate(solutions):
                score = evaluate_multi_ref(
                    list(sol), eval_refs, 0, reference_dist, project_root,
                )
                fitnesses.append(-score)  # CMA-ES minimizes

        es.tell(solutions, fitnesses)

        # Track best
        gen_best_idx = np.argmin(fitnesses)
        gen_best_score = -fitnesses[gen_best_idx]
        if gen_best_score > best_score:
            best_score = gen_best_score
            best_vec = clamp_vector(list(solutions[gen_best_idx]))

        elapsed = time.time() - t0
        gen_mean = -np.mean(fitnesses)
        print(f'Gen {gen:3d}: best={gen_best_score:.4f} mean={gen_mean:.4f} '
              f'overall_best={best_score:.4f} ({elapsed:.1f}s)', flush=True)

        # Checkpoint every 10 generations
        if (gen + 1) % 10 == 0:
            ckpt_path = os.path.join(checkpoint_dir, f'cma-gen-{gen + 1}.pkl')
            with open(ckpt_path, 'wb') as f:
                pickle.dump({
                    'es': es,
                    'best_score': best_score,
                    'best_vec': best_vec,
                    'generation': gen,
                }, f)
            print(f'  Checkpoint saved to {ckpt_path}')

        if es.stop():
            print(f'CMA-ES converged at generation {gen}')
            break

    # Save final results
    result_path = os.path.join(project_root, 'tools/cma-best-vector.json')
    with open(result_path, 'w') as f:
        json.dump({
            'score': best_score,
            'vector': best_vec,
            'params': dict(zip(PARAM_NAMES, best_vec)),
            'generations': gen + 1,
        }, f, indent=2)
    print(f'\nBest score: {best_score:.4f}')
    print(f'Best vector saved to {result_path}')

    # Pretty-print the best parameters
    print('\n--- Best Parameters ---')
    for name, val in zip(PARAM_NAMES, best_vec):
        print(f'  {name:30s} = {val:.4f}')


def main():
    parser = argparse.ArgumentParser(description='CMA-ES optimizer for Beckett painting params')
    parser.add_argument('--reference-dir', default='test/clarice/reference',
                        help='Directory of Beckett reference images')
    parser.add_argument('--generations', type=int, default=150,
                        help='Number of CMA-ES generations')
    parser.add_argument('--popsize', type=int, default=25,
                        help='CMA-ES population size')
    parser.add_argument('--workers', type=int, default=1,
                        help='Parallel workers for evaluation')
    parser.add_argument('--eval-refs', type=int, default=3,
                        help='Number of diverse references per evaluation')
    parser.add_argument('--seed', type=int, default=42,
                        help='Random seed')
    parser.add_argument('--resume', type=str, default=None,
                        help='Resume from checkpoint pickle')

    args = parser.parse_args()
    run_optimization(args)


if __name__ == '__main__':
    main()
