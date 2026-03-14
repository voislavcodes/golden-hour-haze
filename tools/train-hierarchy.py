#!/usr/bin/env python3
"""Train 5 ONNX models for Clarice hierarchy from exported JSONL data.

Usage:
  pip install -r tools/requirements.txt
  python tools/train-hierarchy.py [--data training-data/hierarchy-export.jsonl] [--output public/models/]

Models trained:
  T8  StrokeTypeNet     — patch[N,3,16,16] + features[N,6] → class(5)
  T9  ShapeRecipeNet    — silhouette[N,1,16,16] + scalars[N,13] → class(10)
  O1  CompositionNet    — features[N,30] → class(6)
  SO1 ParamRefineNet    — context[N,32] → params(5) sigmoid
  SO2 ConductorNet      — input[N,30] → decisions(7)
"""

import argparse
import base64
import json
import struct
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset, random_split

# ── Label mappings ──

STROKE_TYPES = ['horizontal-wash', 'vertical-stroke', 'clustered-dabs', 'single-dab', 'arc']
RECIPE_CLASSES = [
    'figure-umbrella', 'figure-standing', 'pole-simple', 'pole-crossbar',
    'tree-rounded', 'tree-spread', 'hedge-band', 'vehicle-body',
    'building-block', 'atmospheric-wash',
]
COMPOSITION_CLASSES = [
    'lonely-figure', 'street-scene', 'seascape',
    'twilight-glow', 'intimate-scene', 'abstract-masses',
]
REGION_CLASSES = ['sky', 'ground', 'horizon', 'mass', 'vertical', 'accent', 'reflection', 'fill']
DEPTH_CLASSES = ['near', 'mid', 'far']

# Default conductor params per composition class (for SO2 target recomputation)
COMPOSITION_DEFAULTS = {
    'lonely-figure':  {'restraint': 0.65, 'focalDensity': 2.00, 'veilStrength': 0.70,
                       'bareCanvasThreshold': 0.05, 'darkSoftening': 0.50,
                       'accentTiming': 0.85, 'interRegionBleed': 0.60},
    'street-scene':   {'restraint': 0.70, 'focalDensity': 1.80, 'veilStrength': 0.55,
                       'bareCanvasThreshold': 0.00, 'darkSoftening': 0.35,
                       'accentTiming': 0.85, 'interRegionBleed': 0.45},
    'seascape':       {'restraint': 0.60, 'focalDensity': 1.30, 'veilStrength': 0.75,
                       'bareCanvasThreshold': 0.05, 'darkSoftening': 0.45,
                       'accentTiming': 0.40, 'interRegionBleed': 0.55},
    'twilight-glow':  {'restraint': 0.55, 'focalDensity': 1.50, 'veilStrength': 0.80,
                       'bareCanvasThreshold': 0.00, 'darkSoftening': 0.55,
                       'accentTiming': 0.70, 'interRegionBleed': 0.65},
    'intimate-scene': {'restraint': 0.65, 'focalDensity': 1.50, 'veilStrength': 0.55,
                       'bareCanvasThreshold': 0.00, 'darkSoftening': 0.40,
                       'accentTiming': 0.85, 'interRegionBleed': 0.50},
    'abstract-masses':{'restraint': 0.60, 'focalDensity': 1.20, 'veilStrength': 0.60,
                       'bareCanvasThreshold': 0.00, 'darkSoftening': 0.35,
                       'accentTiming': 0.85, 'interRegionBleed': 0.55},
}


def b64_to_f32(b64_str: str) -> np.ndarray:
    raw = base64.b64decode(b64_str)
    return np.frombuffer(raw, dtype=np.float32)


# ── Data loading ──

def load_corrections(path: str) -> dict:
    """Load vision corrections from JSONL. Returns {filename: corrected_class}."""
    corrections = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get('type') == 'scene':
                corrections[rec['file']] = rec['composition']
    print(f"Loaded {len(corrections)} vision corrections")
    return corrections


def apply_corrections(scenes: list, corrections: dict):
    """Apply composition corrections and recompute SO2 conductor targets."""
    changed = 0
    for s in scenes:
        fname = s['file']
        if fname in corrections:
            old_class = s['composition']['class']
            new_class = corrections[fname]
            if old_class != new_class:
                s['composition']['class'] = new_class
                s['composition']['confidence'] = 1.0  # vision-verified

                # Recompute conductor targets from class defaults + fogDensity modulation
                defaults = COMPOSITION_DEFAULTS[new_class]
                fog = s.get('fogDensity', 0.5)
                s['conductor'] = {
                    'restraint': defaults['restraint'],
                    'focalDensity': defaults['focalDensity'],
                    'veilStrength': defaults['veilStrength'] + (fog - 0.5) * 0.4,
                    'bareCanvasThreshold': defaults['bareCanvasThreshold'],
                    'darkSoftening': defaults['darkSoftening'],
                    'accentTiming': defaults['accentTiming'],
                    'interRegionBleed': defaults['interRegionBleed'],
                }
                changed += 1
    print(f"Applied {changed} composition corrections")


def print_distribution(scenes: list, label: str):
    """Print composition class distribution."""
    from collections import Counter
    counts = Counter(s['composition']['class'] for s in scenes)
    print(f"\n  {label}:")
    for cls in COMPOSITION_CLASSES:
        print(f"    {cls:20s} {counts.get(cls, 0):3d}")


def load_data(path: str):
    scenes = []
    regions = []
    with open(path) as f:
        for line in f:
            rec = json.loads(line)
            if rec['type'] == 'scene':
                scenes.append(rec)
            elif rec['type'] == 'region':
                regions.append(rec)
    print(f"Loaded {len(scenes)} scenes, {len(regions)} regions")
    return scenes, regions


# ── Model architectures ──

class StrokeTypeNet(nn.Module):
    """T8: Conv(3→16)→Pool→Conv(16→32)→Pool→cat(flat,Dense(6→16))→Dense(→32)→Dense(→5)"""
    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv2d(3, 16, 3, padding=1)
        self.conv2 = nn.Conv2d(16, 32, 3, padding=1)
        self.pool = nn.MaxPool2d(2)
        self.feat_fc = nn.Linear(6, 16)
        self.fc1 = nn.Linear(32 * 4 * 4 + 16, 32)
        self.fc2 = nn.Linear(32, 5)
        self.relu = nn.ReLU()

    def forward(self, patch, features):
        x = self.relu(self.conv1(patch))     # [N,16,16,16]
        x = self.pool(x)                      # [N,16,8,8]
        x = self.relu(self.conv2(x))          # [N,32,8,8]
        x = self.pool(x)                      # [N,32,4,4]
        x = x.flatten(1)                      # [N,512]
        f = self.relu(self.feat_fc(features))  # [N,16]
        x = torch.cat([x, f], dim=1)          # [N,528]
        x = self.relu(self.fc1(x))            # [N,32]
        return self.fc2(x)                     # [N,5]


class ShapeRecipeNet(nn.Module):
    """T9: Conv(1→16)→Pool→Conv(16→32)→Pool→cat(flat,Dense(13→24))→Dense(→48)→Dense(→10)"""
    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv2d(1, 16, 3, padding=1)
        self.conv2 = nn.Conv2d(16, 32, 3, padding=1)
        self.pool = nn.MaxPool2d(2)
        self.scalar_fc = nn.Linear(13, 24)
        self.fc1 = nn.Linear(32 * 4 * 4 + 24, 48)
        self.fc2 = nn.Linear(48, 10)
        self.relu = nn.ReLU()

    def forward(self, silhouette, scalars):
        x = self.relu(self.conv1(silhouette))
        x = self.pool(x)
        x = self.relu(self.conv2(x))
        x = self.pool(x)
        x = x.flatten(1)
        s = self.relu(self.scalar_fc(scalars))
        x = torch.cat([x, s], dim=1)
        x = self.relu(self.fc1(x))
        return self.fc2(x)


class CompositionNet(nn.Module):
    """O1: Dense(30→48,GELU)→Dense(48→32)→Dense(32→16)→Dense(16→6)"""
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(30, 48), nn.GELU(),
            nn.Linear(48, 32), nn.ReLU(),
            nn.Linear(32, 16), nn.ReLU(),
            nn.Linear(16, 6),
        )

    def forward(self, features):
        return self.net(features)


class ParamRefineNet(nn.Module):
    """SO1: Dense(32→64,GELU)→Dense(64→32)→Dense(32→5,Sigmoid)"""
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(32, 64), nn.GELU(),
            nn.Linear(64, 32), nn.ReLU(),
            nn.Linear(32, 5), nn.Sigmoid(),
        )

    def forward(self, context):
        return self.net(context)


class ConductorNet(nn.Module):
    """SO2: Dense(30→16,GELU)→Dense(16→7) — ~700 params"""
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(30, 16), nn.GELU(),
            nn.Linear(16, 7),
        )

    def forward(self, inp):
        return self.net(inp)


# ── Training helpers ──

def train_classifier(model, X, y, epochs=200, lr=1e-3, batch_size=64, patience=30,
                     model_name="model", multi_input=False, class_weights=None):
    """Train a classification model with early stopping."""
    n = len(y)
    n_val = max(1, n // 5)
    n_train = n - n_val

    if multi_input:
        datasets = [TensorDataset(x, y) for x in X]
        # For multi-input, manually split
        indices = torch.randperm(n)
        train_idx, val_idx = indices[:n_train], indices[n_train:]

        X_train = [x[train_idx] for x in X]
        X_val = [x[val_idx] for x in X]
        y_train, y_val = y[train_idx], y[val_idx]

        train_ds = TensorDataset(*X_train, y_train)
        val_ds = TensorDataset(*X_val, y_val)
    else:
        dataset = TensorDataset(X, y)
        train_ds, val_ds = random_split(dataset, [n_train, n_val])

    train_dl = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_dl = DataLoader(val_ds, batch_size=batch_size)

    criterion = nn.CrossEntropyLoss(weight=class_weights)
    optimizer = optim.Adam(model.parameters(), lr=lr)

    best_val_loss = float('inf')
    best_state = None
    stale = 0

    for epoch in range(epochs):
        model.train()
        total_loss = 0
        for batch in train_dl:
            if multi_input:
                *inputs, targets = batch
                logits = model(*inputs)
            else:
                inputs, targets = batch
                logits = model(inputs)
            loss = criterion(logits, targets)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        model.eval()
        val_loss = 0
        correct = 0
        total = 0
        with torch.no_grad():
            for batch in val_dl:
                if multi_input:
                    *inputs, targets = batch
                    logits = model(*inputs)
                else:
                    inputs, targets = batch
                    logits = model(inputs)
                val_loss += criterion(logits, targets).item()
                pred = logits.argmax(dim=1)
                correct += (pred == targets).sum().item()
                total += len(targets)

        val_loss /= max(1, len(val_dl))
        acc = correct / max(1, total)

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            stale = 0
        else:
            stale += 1

        if (epoch + 1) % 50 == 0 or epoch == 0:
            print(f"  [{model_name}] epoch {epoch+1}/{epochs} val_loss={val_loss:.4f} acc={acc:.2%}")

        if stale >= patience:
            print(f"  [{model_name}] early stopping at epoch {epoch+1}")
            break

    if best_state:
        model.load_state_dict(best_state)
    return model


def train_regressor(model, X, y, epochs=300, lr=5e-4, batch_size=64, patience=30,
                    model_name="model", weight_decay=0, multi_input=False):
    """Train a regression model with early stopping."""
    n = len(y)
    n_val = max(1, n // 5)
    n_train = n - n_val

    if multi_input:
        indices = torch.randperm(n)
        train_idx, val_idx = indices[:n_train], indices[n_train:]
        X_train = [x[train_idx] for x in X]
        X_val = [x[val_idx] for x in X]
        y_train, y_val = y[train_idx], y[val_idx]
        train_ds = TensorDataset(*X_train, y_train)
        val_ds = TensorDataset(*X_val, y_val)
    else:
        dataset = TensorDataset(X, y)
        train_ds, val_ds = random_split(dataset, [n_train, n_val])

    train_dl = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_dl = DataLoader(val_ds, batch_size=batch_size)

    criterion = nn.MSELoss()
    optimizer = optim.Adam(model.parameters(), lr=lr, weight_decay=weight_decay)

    best_val_loss = float('inf')
    best_state = None
    stale = 0

    for epoch in range(epochs):
        model.train()
        for batch in train_dl:
            if multi_input:
                *inputs, targets = batch
                out = model(*inputs)
            else:
                inputs, targets = batch
                out = model(inputs)
            loss = criterion(out, targets)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

        model.eval()
        val_loss = 0
        with torch.no_grad():
            for batch in val_dl:
                if multi_input:
                    *inputs, targets = batch
                    out = model(*inputs)
                else:
                    inputs, targets = batch
                    out = model(inputs)
                val_loss += criterion(out, targets).item()
        val_loss /= max(1, len(val_dl))

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            stale = 0
        else:
            stale += 1

        if (epoch + 1) % 50 == 0 or epoch == 0:
            print(f"  [{model_name}] epoch {epoch+1}/{epochs} val_loss={val_loss:.6f}")

        if stale >= patience:
            print(f"  [{model_name}] early stopping at epoch {epoch+1}")
            break

    if best_state:
        model.load_state_dict(best_state)
    return model


def export_onnx(model, dummy_inputs, input_names, output_path, opset=13):
    """Export model to ONNX with dynamic batch axes."""
    model.eval()
    dynamic_axes = {name: {0: 'batch'} for name in input_names}
    dynamic_axes['output'] = {0: 'batch'}

    if isinstance(dummy_inputs, (list, tuple)):
        torch.onnx.export(
            model, tuple(dummy_inputs),
            str(output_path),
            input_names=input_names,
            output_names=['output'],
            dynamic_axes=dynamic_axes,
            opset_version=opset,
        )
    else:
        torch.onnx.export(
            model, dummy_inputs,
            str(output_path),
            input_names=input_names,
            output_names=['output'],
            dynamic_axes=dynamic_axes,
            opset_version=opset,
        )
    size_kb = output_path.stat().st_size / 1024
    print(f"  Exported {output_path.name} ({size_kb:.1f} KB)")


# ── Main ──

def main():
    parser = argparse.ArgumentParser(description='Train Clarice hierarchy models')
    parser.add_argument('--data', default='training-data/hierarchy-export.jsonl')
    parser.add_argument('--output', default='public/models/')
    parser.add_argument('--corrections', default=None,
                        help='Path to vision corrections JSONL (overrides heuristic labels)')
    args = parser.parse_args()

    data_path = Path(args.data)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not data_path.exists():
        print(f"Error: {data_path} not found. Run export first:")
        print("  CHROME=1 npx playwright test test/clarice/export-hierarchy-data.spec.ts --project=clarice")
        sys.exit(1)

    scenes, regions = load_data(str(data_path))

    # Apply vision corrections if provided
    if args.corrections:
        corrections_path = Path(args.corrections)
        if not corrections_path.exists():
            print(f"Error: corrections file {corrections_path} not found")
            sys.exit(1)
        print_distribution(scenes, "BEFORE corrections")
        corrections = load_corrections(str(corrections_path))
        apply_corrections(scenes, corrections)
        print_distribution(scenes, "AFTER corrections")

    # ── T8: Stroke Type ──
    print("\n═══ T8: StrokeTypeNet ═══")
    patches_t8, features_t8, labels_t8 = [], [], []
    for r in regions:
        patch = b64_to_f32(r['patch'])
        if len(patch) == 768:
            patches_t8.append(patch.reshape(3, 16, 16))
            f = r['features']
            features_t8.append([f['x'], f['y'], f['aspectRatio'], f['areaFraction'],
                                f['meldrumIndex'], f['maxChroma']])
            labels_t8.append(STROKE_TYPES.index(r['strokeType']))

    if patches_t8:
        X_patch = torch.tensor(np.array(patches_t8), dtype=torch.float32)
        X_feat = torch.tensor(np.array(features_t8), dtype=torch.float32)
        y_t8 = torch.tensor(labels_t8, dtype=torch.long)
        print(f"  {len(labels_t8)} samples, {len(set(labels_t8))} classes")

        model_t8 = StrokeTypeNet()
        train_classifier(model_t8, [X_patch, X_feat], y_t8, epochs=200, model_name="T8",
                         multi_input=True)
        export_onnx(model_t8,
                    [torch.randn(1, 3, 16, 16), torch.randn(1, 6)],
                    ['patch', 'features'],
                    output_dir / 'stroke-type.onnx')
    else:
        print("  No T8 data — skipping")

    # ── T9: Shape Recipe ──
    print("\n═══ T9: ShapeRecipeNet ═══")
    # Silhouette patches aren't in the export (they need map context in browser).
    # Use a synthetic 16x16 from bounding box as proxy.
    sil_t9, scalars_t9, labels_t9 = [], [], []
    for r in regions:
        # Build a simple binary mask from bounding box ratio
        bb = r['boundingBox']
        bw = bb['x1'] - bb['x0'] + 1
        bh = bb['y1'] - bb['y0'] + 1
        sil = np.zeros((16, 16), dtype=np.float32)
        # Fill proportional region
        fill_w = min(16, max(1, int(16 * min(bw / 40, 1))))
        fill_h = min(16, max(1, int(16 * min(bh / 30, 1))))
        x0 = (16 - fill_w) // 2
        y0 = (16 - fill_h) // 2
        sil[y0:y0+fill_h, x0:x0+fill_w] = 1.0
        sil_t9.append(sil.reshape(1, 16, 16))

        # 13 scalars: classification one-hot(8) + depth one-hot(3) + aspect + area
        cls_oh = [1.0 if REGION_CLASSES[i] == r['classification'] else 0.0 for i in range(8)]
        depth_oh = [1.0 if DEPTH_CLASSES[i] == r['depth'] else 0.0 for i in range(3)]
        aspect = r['features']['aspectRatio'] if 'aspectRatio' in r['features'] else 1.0
        area = r['features']['areaFraction'] if 'areaFraction' in r['features'] else 0.01
        scalars_t9.append(cls_oh + depth_oh + [aspect, area])

        labels_t9.append(RECIPE_CLASSES.index(r['recipe']))

    if sil_t9:
        X_sil = torch.tensor(np.array(sil_t9), dtype=torch.float32)
        X_sc = torch.tensor(np.array(scalars_t9), dtype=torch.float32)
        y_t9 = torch.tensor(labels_t9, dtype=torch.long)
        print(f"  {len(labels_t9)} samples, {len(set(labels_t9))} classes")

        model_t9 = ShapeRecipeNet()
        train_classifier(model_t9, [X_sil, X_sc], y_t9, epochs=200, model_name="T9",
                         multi_input=True)
        export_onnx(model_t9,
                    [torch.randn(1, 1, 16, 16), torch.randn(1, 13)],
                    ['silhouette', 'scalars'],
                    output_dir / 'shape-recipe.onnx')
    else:
        print("  No T9 data — skipping")

    # ── O1: Composition ──
    print("\n═══ O1: CompositionNet ═══")
    features_o1, labels_o1 = [], []
    for s in scenes:
        feat = b64_to_f32(s['sceneFeatures'])
        if len(feat) == 30:
            features_o1.append(feat)
            labels_o1.append(COMPOSITION_CLASSES.index(s['composition']['class']))

    if features_o1:
        X_o1 = torch.tensor(np.array(features_o1), dtype=torch.float32)
        y_o1 = torch.tensor(labels_o1, dtype=torch.long)
        n_classes = len(COMPOSITION_CLASSES)
        present_classes = set(labels_o1)
        print(f"  {len(labels_o1)} samples, {len(present_classes)} classes present")

        # Compute inverse-frequency class weights for imbalanced data
        from collections import Counter
        counts = Counter(labels_o1)
        total = len(labels_o1)
        weights = []
        for i in range(n_classes):
            c = counts.get(i, 0)
            if c > 0:
                weights.append(total / (n_classes * c))
            else:
                weights.append(0.0)  # zero weight for absent classes
        class_weights = torch.tensor(weights, dtype=torch.float32)
        print(f"  Class weights: {dict(zip(COMPOSITION_CLASSES, [f'{w:.2f}' for w in weights]))}")

        model_o1 = CompositionNet()
        train_classifier(model_o1, X_o1, y_o1, epochs=200, model_name="O1",
                         class_weights=class_weights)
        export_onnx(model_o1, torch.randn(1, 30), ['features'],
                    output_dir / 'composition.onnx')
    else:
        print("  No O1 data — skipping")

    # ── SO1: Parameter Refinement ──
    print("\n═══ SO1: ParamRefineNet ═══")
    # Build context vectors and target params from region data
    # Note: Full context serialization requires data not in export.
    # Use a simplified 32-dim context from available region fields.
    ctx_so1, params_so1 = [], []
    for r in regions:
        f = r['features']
        cls_oh = [1.0 if REGION_CLASSES[i] == r['classification'] else 0.0 for i in range(8)]
        depth_oh = [1.0 if DEPTH_CLASSES[i] == r['depth'] else 0.0 for i in range(3)]
        tone = r.get('tone', 2) / 4.0
        cx, cy = r['centroid']['x'], r['centroid']['y']
        focal_dist = 0.5  # placeholder — actual focal dist not in export
        comp_oh = [0.0] * 6  # placeholder
        fog = 0.5  # placeholder
        area = f['areaFraction']
        chroma = f['maxChroma']
        edge_sharp = 0.5  # placeholder
        is_accent = 1.0 if r['classification'] == 'accent' else 0.0
        st_oh = [1.0 if STROKE_TYPES[i] == r['strokeType'] else 0.0 for i in range(5)]
        same_band = 3  # placeholder

        ctx = cls_oh + depth_oh + [tone, cx, cy, focal_dist] + comp_oh + \
              [fog, area, chroma, edge_sharp, is_accent] + st_oh + [same_band]
        assert len(ctx) == 32, f"Expected 32, got {len(ctx)}"
        ctx_so1.append(ctx)

        # Target: normalized params from heuristic (infer from classification defaults)
        # Since we don't have actual refined params in export, use heuristic approximation
        base_configs = {
            'sky':        [0.08, 0.55, 0.45, 4],
            'ground':     [0.02, 0.65, 0.55, 3],
            'horizon':    [0.04, 0.60, 0.50, 3],
            'mass':       [0.01, 0.75, 0.60, 2],
            'vertical':   [0.00, 0.80, 0.60, 1],
            'accent':     [0.00, 0.65, 0.65, 1],
            'reflection': [0.06, 0.50, 0.45, 2],
            'fill':       [0.03, 0.60, 0.50, 3],
        }
        base = base_configs.get(r['classification'], [0.03, 0.60, 0.50, 2])
        # Normalize to [0,1] for sigmoid output
        thinners_n = base[0] / 0.18
        load_n = (base[1] - 0.15) / 0.85
        pressure_n = (base[2] - 0.20) / 0.70
        brush_n = base[3] / 4.0
        params_so1.append([thinners_n, load_n, pressure_n, brush_n, 0.5])  # 5th is reserved

    if ctx_so1:
        X_so1 = torch.tensor(np.array(ctx_so1), dtype=torch.float32)
        y_so1 = torch.tensor(np.array(params_so1), dtype=torch.float32)
        print(f"  {len(ctx_so1)} samples")

        model_so1 = ParamRefineNet()
        train_regressor(model_so1, X_so1, y_so1, epochs=300, model_name="SO1")
        export_onnx(model_so1, torch.randn(1, 32), ['context'],
                    output_dir / 'param-refinement.onnx')
    else:
        print("  No SO1 data — skipping")

    # ── SO2: Conductor ──
    print("\n═══ SO2: ConductorNet ═══")
    inputs_so2, outputs_so2 = [], []
    for s in scenes:
        inp = b64_to_f32(s['conductorInput'])
        if len(inp) == 30:
            inputs_so2.append(inp)
            c = s['conductor']
            outputs_so2.append([
                c['restraint'], c['focalDensity'],
                c['veilStrength'], c['bareCanvasThreshold'],
                c['darkSoftening'], c['accentTiming'], c['interRegionBleed'],
            ])

    if inputs_so2:
        X_so2 = torch.tensor(np.array(inputs_so2), dtype=torch.float32)
        y_so2 = torch.tensor(np.array(outputs_so2), dtype=torch.float32)
        print(f"  {len(inputs_so2)} samples")

        model_so2 = ConductorNet()
        train_regressor(model_so2, X_so2, y_so2, epochs=200, lr=5e-4,
                        batch_size=16, model_name="SO2", weight_decay=1e-3)
        export_onnx(model_so2, torch.randn(1, 30), ['input'],
                    output_dir / 'painting-conductor.onnx')
    else:
        print("  No SO2 data — skipping")

    print("\n✓ All models trained and exported to", output_dir)
    total_size = sum(f.stat().st_size for f in output_dir.glob('*.onnx'))
    print(f"  Total model size: {total_size / 1024:.1f} KB")


if __name__ == '__main__':
    main()
