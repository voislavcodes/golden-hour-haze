"""
Beckett painting critic — 6-channel perceptual fingerprint extractor and scorer.

Extracts a 69-dimensional fingerprint (16+12+8+8+16+9) across six perceptual
channels calibrated to Beckett's tonalist style: compressed midtones, extreme
desaturation, atmospheric softness, horizontal/vertical structure, sparse
detail, and centrally-weighted composition.

Usage:
    python tools/beckett_critic.py build --input-dir test/clarice/reference
    python tools/beckett_critic.py score --candidate output.png
    python tools/beckett_critic.py validate --input-dir test/clarice/reference
"""

import argparse
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy.stats import wasserstein_distance


# ---------------------------------------------------------------------------
# OKLab conversion
# ---------------------------------------------------------------------------

def srgb_to_oklab(r: float, g: float, b: float) -> tuple[float, float, float]:
    """Convert a single sRGB pixel (0-1 floats) to OKLab (L, a, b)."""

    def linearize(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    lr, lg, lb = linearize(r), linearize(g), linearize(b)

    # Linear RGB to LMS
    l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
    m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
    s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb

    # Cube root (handle negatives safely)
    l_ = np.cbrt(l)
    m_ = np.cbrt(m)
    s_ = np.cbrt(s)

    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    bk = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_

    return L, a, bk


def image_to_oklab(img_rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Convert an HxWx3 uint8 RGB image to OKLab channels (L, a, b) as float arrays.

    Returns three HxW float64 arrays.
    """
    rgb = img_rgb.astype(np.float64) / 255.0
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]

    # Vectorized linearization
    lr = np.where(r <= 0.04045, r / 12.92, ((r + 0.055) / 1.055) ** 2.4)
    lg = np.where(g <= 0.04045, g / 12.92, ((g + 0.055) / 1.055) ** 2.4)
    lb = np.where(b <= 0.04045, b / 12.92, ((b + 0.055) / 1.055) ** 2.4)

    # Linear RGB to LMS
    l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
    m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
    s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb

    l_ = np.cbrt(l)
    m_ = np.cbrt(m)
    s_ = np.cbrt(s)

    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    bk = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_

    return L, a, bk


# ---------------------------------------------------------------------------
# Channel extractors
# ---------------------------------------------------------------------------

def ch1_tonal_histogram(img_rgb: np.ndarray) -> np.ndarray:
    """Ch1: 16-bin tonal histogram of OKLab L* channel.

    Measures Beckett's characteristic compressed midtone range.
    Returns a 16-element normalized histogram (sums to 1).
    """
    L, _, _ = image_to_oklab(img_rgb)
    L_clamped = np.clip(L, 0.0, 1.0)
    hist, _ = np.histogram(L_clamped.ravel(), bins=16, range=(0.0, 1.0))
    hist = hist.astype(np.float64)
    total = hist.sum()
    if total > 0:
        hist /= total
    return hist


def ch2_chroma_histogram(img_rgb: np.ndarray) -> np.ndarray:
    """Ch2: 12-bin chroma histogram from OKLab.

    Measures extreme desaturation with rare vivid accents.
    Chroma = sqrt(a^2 + b^2), binned over [0, 0.35].
    Returns a 12-element normalized histogram (sums to 1).
    """
    _, a, b = image_to_oklab(img_rgb)
    chroma = np.sqrt(a ** 2 + b ** 2)
    chroma_clamped = np.clip(chroma, 0.0, 0.35)
    hist, _ = np.histogram(chroma_clamped.ravel(), bins=12, range=(0.0, 0.35))
    hist = hist.astype(np.float64)
    total = hist.sum()
    if total > 0:
        hist /= total
    return hist


def ch3_radial_fft(img_rgb: np.ndarray) -> np.ndarray:
    """Ch3: 8-bin radial FFT power spectrum.

    Measures Beckett's distinctive atmospheric softness/blur.
    Converts to grayscale, computes 2D FFT, averages power into 8
    log-spaced radial frequency bins, and normalizes.
    Returns an 8-element normalized array.
    """
    gray = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY).astype(np.float64)

    # 2D FFT, shift zero-frequency to center
    f = np.fft.fft2(gray)
    f_shift = np.fft.fftshift(f)
    power = np.abs(f_shift) ** 2

    h, w = gray.shape
    cy, cx = h // 2, w // 2

    # Distance from center for each pixel
    y_coords, x_coords = np.ogrid[:h, :w]
    dist = np.sqrt((y_coords - cy) ** 2 + (x_coords - cx) ** 2)

    # Maximum radius
    max_radius = np.sqrt(cy ** 2 + cx ** 2)

    # 8 log-spaced bin edges from 1 to max_radius
    bin_edges = np.logspace(0, np.log10(max_radius), num=9)

    bins = np.zeros(8, dtype=np.float64)
    for i in range(8):
        mask = (dist >= bin_edges[i]) & (dist < bin_edges[i + 1])
        count = mask.sum()
        if count > 0:
            bins[i] = power[mask].mean()

    # Normalize
    total = bins.sum()
    if total > 0:
        bins /= total
    return bins


def ch4_gradient_orientation(img_rgb: np.ndarray) -> np.ndarray:
    """Ch4: 8-bin gradient orientation histogram.

    Captures horizontal sky / vertical figure structure characteristic
    of Beckett landscapes. Sobel gradients, magnitude-weighted orientation
    histogram over [0, pi].
    Returns an 8-element normalized histogram.
    """
    gray = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY).astype(np.float64)

    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)

    magnitude = np.sqrt(gx ** 2 + gy ** 2)
    orientation = np.arctan2(gy, gx)  # [-pi, pi]

    # Map to [0, pi] — direction without sign
    orientation = np.mod(orientation, np.pi)

    # Magnitude-weighted histogram
    hist, _ = np.histogram(
        orientation.ravel(),
        bins=8,
        range=(0.0, np.pi),
        weights=magnitude.ravel(),
    )
    hist = hist.astype(np.float64)
    total = hist.sum()
    if total > 0:
        hist /= total
    return hist


def ch5_edge_density_grid(img_rgb: np.ndarray) -> np.ndarray:
    """Ch5: 4x4 edge density grid (16 values).

    Measures where visual detail concentrates on the canvas.
    Canny edge detection, then edge pixel density per cell,
    normalized by max cell value.
    Returns a 16-element array (row-major 4x4).
    """
    gray = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 50, 150)

    h, w = edges.shape
    grid = np.zeros((4, 4), dtype=np.float64)

    cell_h = h / 4
    cell_w = w / 4

    for row in range(4):
        for col in range(4):
            r0 = int(round(row * cell_h))
            r1 = int(round((row + 1) * cell_h))
            c0 = int(round(col * cell_w))
            c1 = int(round((col + 1) * cell_w))
            cell = edges[r0:r1, c0:c1]
            area = cell.size
            if area > 0:
                grid[row, col] = np.count_nonzero(cell) / area

    max_val = grid.max()
    if max_val > 0:
        grid /= max_val
    return grid.ravel()


def ch6_composition_mass_grid(img_rgb: np.ndarray) -> np.ndarray:
    """Ch6: 3x3 composition mass grid (9 values).

    Measures weight distribution on canvas. Mean darkness (1-L)
    per cell in a 3x3 grid, normalized by total sum.
    Returns a 9-element array (row-major 3x3).
    """
    L, _, _ = image_to_oklab(img_rgb)
    darkness = 1.0 - np.clip(L, 0.0, 1.0)

    h, w = darkness.shape
    grid = np.zeros((3, 3), dtype=np.float64)

    cell_h = h / 3
    cell_w = w / 3

    for row in range(3):
        for col in range(3):
            r0 = int(round(row * cell_h))
            r1 = int(round((row + 1) * cell_h))
            c0 = int(round(col * cell_w))
            c1 = int(round((col + 1) * cell_w))
            cell = darkness[r0:r1, c0:c1]
            grid[row, col] = cell.mean()

    total = grid.sum()
    if total > 0:
        grid /= total
    return grid.ravel()


# ---------------------------------------------------------------------------
# Fingerprint
# ---------------------------------------------------------------------------

def extract_fingerprint(img_rgb: np.ndarray) -> dict:
    """Extract the full 6-channel fingerprint from an RGB image.

    Args:
        img_rgb: HxWx3 uint8 numpy array in RGB order.

    Returns:
        Dict with keys 'ch1' through 'ch6', each a list of floats.
    """
    return {
        'ch1': ch1_tonal_histogram(img_rgb).tolist(),
        'ch2': ch2_chroma_histogram(img_rgb).tolist(),
        'ch3': ch3_radial_fft(img_rgb).tolist(),
        'ch4': ch4_gradient_orientation(img_rgb).tolist(),
        'ch5': ch5_edge_density_grid(img_rgb).tolist(),
        'ch6': ch6_composition_mass_grid(img_rgb).tolist(),
    }


def load_image_rgb(path: str) -> np.ndarray:
    """Load an image file and return it as an HxWx3 uint8 RGB array."""
    img = Image.open(path).convert('RGB')
    return np.array(img)


# ---------------------------------------------------------------------------
# Channel distance functions
# ---------------------------------------------------------------------------

# Channels using histogram (EMD) distance
HISTOGRAM_CHANNELS = {'ch1', 'ch2', 'ch3', 'ch4'}

# Channels using spatial grid (MSE) distance
SPATIAL_CHANNELS = {'ch5', 'ch6'}

# Per-channel weights
CHANNEL_WEIGHTS = {
    'ch1': 2.0,   # tonal
    'ch2': 1.5,   # chroma
    'ch3': 1.0,   # fft
    'ch4': 1.0,   # gradient
    'ch5': 1.5,   # edge density
    'ch6': 1.0,   # composition
}

ALL_CHANNELS = ['ch1', 'ch2', 'ch3', 'ch4', 'ch5', 'ch6']


def channel_distance(a: np.ndarray, b: np.ndarray, channel: str) -> float:
    """Compute distance between two vectors for a given channel.

    Histogram channels use Earth Mover's Distance (Wasserstein-1).
    Spatial grid channels use mean squared error.
    """
    if channel in HISTOGRAM_CHANNELS:
        return wasserstein_distance(a, b)
    else:
        return float(np.mean((a - b) ** 2))


# ---------------------------------------------------------------------------
# Reference distribution builder
# ---------------------------------------------------------------------------

def build_reference_distribution(image_paths: list[str]) -> dict:
    """Build a reference distribution from a corpus of Beckett paintings.

    Extracts fingerprints from all reference images, then computes
    per-channel statistics (mean, std) and pairwise distances for
    normalization in scoring.

    Args:
        image_paths: List of file paths to reference Beckett paintings.

    Returns:
        Dict with per-channel 'mean', 'std', and 'mean_pairwise_distance',
        plus 'num_images' and 'image_paths'.
    """
    if len(image_paths) == 0:
        raise ValueError("Need at least one reference image")

    fingerprints = []
    for path in image_paths:
        print(f"  Extracting fingerprint: {os.path.basename(path)}")
        img = load_image_rgb(path)
        fp = extract_fingerprint(img)
        fingerprints.append(fp)

    result = {
        'num_images': len(image_paths),
        'image_paths': [os.path.basename(p) for p in image_paths],
        'channels': {},
    }

    for ch in ALL_CHANNELS:
        vectors = [np.array(fp[ch]) for fp in fingerprints]
        stacked = np.stack(vectors)

        mean = stacked.mean(axis=0)
        std = stacked.std(axis=0)

        # Pairwise distances within the corpus
        pairwise_dists = []
        n = len(vectors)
        for i in range(n):
            for j in range(i + 1, n):
                d = channel_distance(vectors[i], vectors[j], ch)
                pairwise_dists.append(d)

        mean_pairwise = float(np.mean(pairwise_dists)) if pairwise_dists else 1e-6

        result['channels'][ch] = {
            'mean': mean.tolist(),
            'std': std.tolist(),
            'mean_pairwise_distance': max(mean_pairwise, 1e-6),
        }

    return result


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score_candidate(candidate_path: str, reference: dict) -> float:
    """Score a candidate painting against the Beckett reference distribution.

    Extracts the candidate's fingerprint, computes per-channel distances
    to the reference mean, normalizes by the reference corpus's internal
    pairwise distance, and returns a weighted composite score.

    Args:
        candidate_path: Path to the candidate image.
        reference: Reference distribution dict from build_reference_distribution.

    Returns:
        Float in [0, 1] where 1.0 = perfect Beckett match.
    """
    img = load_image_rgb(candidate_path)
    fp = extract_fingerprint(img)

    total_weight = sum(CHANNEL_WEIGHTS.values())
    weighted_sum = 0.0

    for ch in ALL_CHANNELS:
        candidate_vec = np.array(fp[ch])
        ref_mean = np.array(reference['channels'][ch]['mean'])
        ref_pairwise = reference['channels'][ch]['mean_pairwise_distance']
        weight = CHANNEL_WEIGHTS[ch]

        dist = channel_distance(candidate_vec, ref_mean, ch)
        normalized_dist = dist / ref_pairwise
        weighted_sum += weight * normalized_dist

    # Exponential decay: always non-zero, always has gradient for CMA-ES.
    # exp(0) = 1.0 (perfect match), exp(-1) ≈ 0.37 (avg pairwise dist)
    weighted_avg = weighted_sum / total_weight
    score = float(np.exp(-weighted_avg))
    return score


def score_candidate_detailed(candidate_path: str, reference: dict) -> dict:
    """Score a candidate with per-channel breakdown.

    Same as score_candidate but returns detailed per-channel info
    for diagnostics.

    Args:
        candidate_path: Path to the candidate image.
        reference: Reference distribution dict from build_reference_distribution.

    Returns:
        Dict with 'score', 'per_channel' breakdown, and 'candidate'.
    """
    img = load_image_rgb(candidate_path)
    fp = extract_fingerprint(img)

    total_weight = sum(CHANNEL_WEIGHTS.values())
    weighted_sum = 0.0
    per_channel = {}

    channel_names = {
        'ch1': 'tonal',
        'ch2': 'chroma',
        'ch3': 'fft',
        'ch4': 'gradient',
        'ch5': 'edge_density',
        'ch6': 'composition',
    }

    for ch in ALL_CHANNELS:
        candidate_vec = np.array(fp[ch])
        ref_mean = np.array(reference['channels'][ch]['mean'])
        ref_pairwise = reference['channels'][ch]['mean_pairwise_distance']
        weight = CHANNEL_WEIGHTS[ch]

        dist = channel_distance(candidate_vec, ref_mean, ch)
        normalized_dist = dist / ref_pairwise
        weighted_sum += weight * normalized_dist

        per_channel[ch] = {
            'name': channel_names[ch],
            'raw_distance': float(dist),
            'normalized_distance': float(normalized_dist),
            'weight': weight,
            'weighted_contribution': float(weight * normalized_dist),
        }

    weighted_avg = weighted_sum / total_weight
    score = float(np.exp(-weighted_avg))

    return {
        'score': score,
        'candidate': os.path.basename(candidate_path),
        'per_channel': per_channel,
    }


# ---------------------------------------------------------------------------
# CLI commands
# ---------------------------------------------------------------------------

def cmd_build(args: argparse.Namespace) -> None:
    """Build reference distribution from a directory of Beckett paintings."""
    input_dir = Path(args.input_dir)
    if not input_dir.is_dir():
        print(f"Error: {input_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    extensions = {'.png', '.jpg', '.jpeg', '.webp', '.bmp'}
    image_paths = sorted([
        str(p) for p in input_dir.iterdir()
        if p.suffix.lower() in extensions
    ])

    if not image_paths:
        print(f"Error: no images found in {input_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Building reference from {len(image_paths)} images in {input_dir}")
    ref = build_reference_distribution(image_paths)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(ref, f, indent=2)

    print(f"Reference distribution saved to {output_path}")
    print(f"  Images: {ref['num_images']}")
    for ch in ALL_CHANNELS:
        mpd = ref['channels'][ch]['mean_pairwise_distance']
        print(f"  {ch} mean pairwise distance: {mpd:.6f}")


def cmd_score(args: argparse.Namespace) -> None:
    """Score a single candidate painting."""
    ref_path = Path(args.reference)
    if not ref_path.is_file():
        print(f"Error: reference file {ref_path} not found", file=sys.stderr)
        print("Run 'build' first to create the reference distribution.", file=sys.stderr)
        sys.exit(1)

    with open(ref_path) as f:
        reference = json.load(f)

    candidate_path = args.candidate
    if not Path(candidate_path).is_file():
        print(f"Error: candidate file {candidate_path} not found", file=sys.stderr)
        sys.exit(1)

    print(f"Scoring: {candidate_path}")
    result = score_candidate_detailed(candidate_path, reference)

    print(f"\n  Overall score: {result['score']:.4f}")
    print(f"  Per-channel breakdown:")
    for ch in ALL_CHANNELS:
        info = result['per_channel'][ch]
        print(
            f"    {ch} ({info['name']:>12s}): "
            f"raw={info['raw_distance']:.6f}  "
            f"norm={info['normalized_distance']:.4f}  "
            f"w={info['weight']:.1f}  "
            f"contrib={info['weighted_contribution']:.4f}"
        )


def cmd_validate(args: argparse.Namespace) -> None:
    """Score all reference paintings against the reference distribution (leave-one-out is not
    implemented; this simply shows how the training images score against their own distribution)."""
    ref_path = Path(args.reference)
    if not ref_path.is_file():
        print(f"Error: reference file {ref_path} not found", file=sys.stderr)
        print("Run 'build' first to create the reference distribution.", file=sys.stderr)
        sys.exit(1)

    with open(ref_path) as f:
        reference = json.load(f)

    input_dir = Path(args.input_dir)
    if not input_dir.is_dir():
        print(f"Error: {input_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    extensions = {'.png', '.jpg', '.jpeg', '.webp', '.bmp'}
    image_paths = sorted([
        str(p) for p in input_dir.iterdir()
        if p.suffix.lower() in extensions
    ])

    if not image_paths:
        print(f"Error: no images found in {input_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Validating {len(image_paths)} images against reference distribution\n")

    scores = []
    for path in image_paths:
        result = score_candidate_detailed(path, reference)
        scores.append(result['score'])
        print(f"  {result['score']:.4f}  {os.path.basename(path)}")

    scores_arr = np.array(scores)
    print(f"\n  Mean:   {scores_arr.mean():.4f}")
    print(f"  Std:    {scores_arr.std():.4f}")
    print(f"  Min:    {scores_arr.min():.4f}")
    print(f"  Max:    {scores_arr.max():.4f}")
    print(f"  Median: {float(np.median(scores_arr)):.4f}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Beckett painting critic — 6-channel fingerprint scorer'
    )
    sub = parser.add_subparsers(dest='command')

    # Build reference distribution
    build_cmd = sub.add_parser(
        'build', help='Build reference distribution from Beckett paintings'
    )
    build_cmd.add_argument(
        '--input-dir', required=True, help='Directory of reference images'
    )
    build_cmd.add_argument(
        '--output', default='tools/beckett-reference.json',
        help='Output JSON path'
    )

    # Score a candidate
    score_cmd = sub.add_parser('score', help='Score a candidate painting')
    score_cmd.add_argument(
        '--candidate', required=True, help='Path to candidate image'
    )
    score_cmd.add_argument(
        '--reference', default='tools/beckett-reference.json',
        help='Reference JSON path'
    )

    # Validate (score known Beckett paintings)
    validate_cmd = sub.add_parser(
        'validate', help='Validate scorer on reference paintings'
    )
    validate_cmd.add_argument(
        '--input-dir', required=True, help='Directory of reference images'
    )
    validate_cmd.add_argument(
        '--reference', default='tools/beckett-reference.json',
        help='Reference JSON path'
    )

    args = parser.parse_args()

    if args.command == 'build':
        cmd_build(args)
    elif args.command == 'score':
        cmd_score(args)
    elif args.command == 'validate':
        cmd_validate(args)
    else:
        parser.print_help()
        sys.exit(1)
