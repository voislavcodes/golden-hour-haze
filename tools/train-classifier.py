#!/usr/bin/env python3
"""
Train Region Classifier — dual-branch CNN for region classification
Reads training data from tools/training-data/ (patches.bin + labels.json)
Exports ONNX model to public/models/region-classifier.onnx

Usage:
    pip install torch numpy onnx
    python tools/train-classifier.py
"""

import json
import struct
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler

PROJECT_ROOT = Path(__file__).parent.parent
TRAINING_DIR = Path(__file__).parent / "training-data"
OUTPUT_PATH = PROJECT_ROOT / "public" / "models" / "region-classifier.onnx"

CLASS_LABELS = ["sky", "ground", "horizon", "mass", "vertical", "accent", "reflection", "fill"]
NUM_CLASSES = len(CLASS_LABELS)
PATCH_SIZE = 16
NUM_FEATURES = 6


class RegionClassifier(nn.Module):
    """Dual-branch CNN: patch branch + scalar features branch."""

    def __init__(self):
        super().__init__()

        # Branch A: 16×16×3 RGB patch
        self.conv1 = nn.Conv2d(3, 16, 3, padding=1)
        self.relu1 = nn.ReLU()
        self.conv2 = nn.Conv2d(16, 32, 3, padding=1)
        self.relu2 = nn.ReLU()
        self.pool = nn.AdaptiveAvgPool2d(1)  # → [B, 32, 1, 1]

        # Branch B: 6 scalar features
        self.fc_feat = nn.Linear(NUM_FEATURES, 16)
        self.relu_feat = nn.ReLU()

        # Head: concat [32 + 16] → 8 classes
        self.fc1 = nn.Linear(48, 32)
        self.relu3 = nn.ReLU()
        self.fc2 = nn.Linear(32, NUM_CLASSES)

    def forward(self, patch: torch.Tensor, features: torch.Tensor) -> torch.Tensor:
        # Branch A
        x = self.relu1(self.conv1(patch))
        x = self.relu2(self.conv2(x))
        x = self.pool(x).flatten(1)  # [B, 32]

        # Branch B
        f = self.relu_feat(self.fc_feat(features))  # [B, 16]

        # Head
        combined = torch.cat([x, f], dim=1)  # [B, 48]
        out = self.relu3(self.fc1(combined))
        return self.fc2(out)  # [B, 8] logits


class RegionDataset(Dataset):
    def __init__(self, patches: np.ndarray, features: np.ndarray, labels: np.ndarray):
        self.patches = torch.from_numpy(patches).float()
        self.features = torch.from_numpy(features).float()
        self.labels = torch.from_numpy(labels).long()

    def __len__(self):
        return len(self.labels)

    def __getitem__(self, idx):
        return self.patches[idx], self.features[idx], self.labels[idx]


def load_data():
    """Load patches and labels from training-data/."""
    labels_path = TRAINING_DIR / "labels.json"
    patches_path = TRAINING_DIR / "patches.bin"

    if not labels_path.exists() or not patches_path.exists():
        print("Training data not found. Run export first:")
        print("  npx tsx tools/export-training-data.ts")
        sys.exit(1)

    with open(labels_path) as f:
        meta = json.load(f)

    n = meta["count"]
    floats_per_patch = 3 * PATCH_SIZE * PATCH_SIZE

    # Read binary patches
    raw = np.fromfile(patches_path, dtype=np.float32)
    patches = raw.reshape(n, 3, PATCH_SIZE, PATCH_SIZE)

    # Extract features and labels
    features = np.zeros((n, NUM_FEATURES), dtype=np.float32)
    label_indices = np.zeros(n, dtype=np.int64)
    class_to_idx = {c: i for i, c in enumerate(CLASS_LABELS)}

    for i, entry in enumerate(meta["entries"]):
        features[i] = entry["features"]
        label_indices[i] = class_to_idx.get(entry["classification"], NUM_CLASSES - 1)

    return patches, features, label_indices


def train():
    print("=== Region Classifier Training ===\n")

    patches, features, labels = load_data()
    n = len(labels)
    print(f"Loaded {n} samples")

    # Class distribution
    unique, counts = np.unique(labels, return_counts=True)
    print("Class distribution:")
    for u, c in zip(unique, counts):
        print(f"  {CLASS_LABELS[u]}: {c} ({c/n*100:.1f}%)")

    # Stratified 80/20 split
    indices = np.arange(n)
    np.random.seed(42)
    np.random.shuffle(indices)
    split = int(n * 0.8)
    train_idx = indices[:split]
    val_idx = indices[split:]

    train_set = RegionDataset(patches[train_idx], features[train_idx], labels[train_idx])
    val_set = RegionDataset(patches[val_idx], features[val_idx], labels[val_idx])

    # Weighted sampler for class imbalance
    train_labels = labels[train_idx]
    class_counts = np.bincount(train_labels, minlength=NUM_CLASSES).astype(np.float64)
    class_counts = np.maximum(class_counts, 1)  # avoid div by zero
    weights = 1.0 / class_counts
    sample_weights = weights[train_labels]
    sampler = WeightedRandomSampler(
        torch.from_numpy(sample_weights).double(),
        num_samples=len(train_labels),
        replacement=True,
    )

    train_loader = DataLoader(train_set, batch_size=32, sampler=sampler)
    val_loader = DataLoader(val_set, batch_size=64, shuffle=False)

    # Model
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = RegionClassifier().to(device)
    param_count = sum(p.numel() for p in model.parameters())
    print(f"\nModel parameters: {param_count:,}")
    print(f"Device: {device}\n")

    # Training
    criterion = nn.CrossEntropyLoss()
    optimizer = optim.Adam(model.parameters(), lr=1e-3)
    scheduler = optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=10, factor=0.5)

    best_val_acc = 0
    patience = 20
    no_improve = 0

    for epoch in range(100):
        model.train()
        train_loss = 0
        train_correct = 0
        train_total = 0

        for batch_patches, batch_features, batch_labels in train_loader:
            batch_patches = batch_patches.to(device)
            batch_features = batch_features.to(device)
            batch_labels = batch_labels.to(device)

            optimizer.zero_grad()
            logits = model(batch_patches, batch_features)
            loss = criterion(logits, batch_labels)
            loss.backward()
            optimizer.step()

            train_loss += loss.item() * len(batch_labels)
            train_correct += (logits.argmax(1) == batch_labels).sum().item()
            train_total += len(batch_labels)

        # Validation
        model.eval()
        val_correct = 0
        val_total = 0
        val_loss = 0

        with torch.no_grad():
            for batch_patches, batch_features, batch_labels in val_loader:
                batch_patches = batch_patches.to(device)
                batch_features = batch_features.to(device)
                batch_labels = batch_labels.to(device)

                logits = model(batch_patches, batch_features)
                loss = criterion(logits, batch_labels)
                val_loss += loss.item() * len(batch_labels)
                val_correct += (logits.argmax(1) == batch_labels).sum().item()
                val_total += len(batch_labels)

        train_acc = train_correct / train_total
        val_acc = val_correct / val_total if val_total > 0 else 0
        avg_val_loss = val_loss / val_total if val_total > 0 else 0
        scheduler.step(avg_val_loss)

        if (epoch + 1) % 5 == 0 or epoch == 0:
            print(f"Epoch {epoch+1:3d}: train_acc={train_acc:.3f} val_acc={val_acc:.3f} val_loss={avg_val_loss:.4f}")

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            no_improve = 0
            # Save best model
            torch.save(model.state_dict(), TRAINING_DIR / "best_model.pt")
        else:
            no_improve += 1

        if no_improve >= patience:
            print(f"\nEarly stopping at epoch {epoch+1} (best val_acc={best_val_acc:.3f})")
            break

    # Load best model
    model.load_state_dict(torch.load(TRAINING_DIR / "best_model.pt", weights_only=True))
    print(f"\nBest validation accuracy: {best_val_acc:.3f}")

    # Export to ONNX
    model.eval()
    model.to("cpu")
    dummy_patch = torch.randn(1, 3, PATCH_SIZE, PATCH_SIZE)
    dummy_features = torch.randn(1, NUM_FEATURES)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    torch.onnx.export(
        model,
        (dummy_patch, dummy_features),
        str(OUTPUT_PATH),
        opset_version=13,
        input_names=["patch", "features"],
        output_names=["logits"],
        dynamic_axes={
            "patch": {0: "batch"},
            "features": {0: "batch"},
            "logits": {0: "batch"},
        },
    )

    model_size = OUTPUT_PATH.stat().st_size
    print(f"\nExported: {OUTPUT_PATH}")
    print(f"Model size: {model_size / 1024:.1f} KB")
    print(f"Parameters: {param_count:,}")

    # Per-class accuracy
    model.eval()
    all_preds = []
    all_labels_list = []

    with torch.no_grad():
        for batch_patches, batch_features, batch_labels in val_loader:
            logits = model(batch_patches, batch_features)
            all_preds.extend(logits.argmax(1).numpy())
            all_labels_list.extend(batch_labels.numpy())

    all_preds = np.array(all_preds)
    all_labels_arr = np.array(all_labels_list)

    print("\nPer-class accuracy:")
    for i, cls in enumerate(CLASS_LABELS):
        mask = all_labels_arr == i
        if mask.sum() > 0:
            acc = (all_preds[mask] == i).mean()
            print(f"  {cls:12s}: {acc:.3f} ({mask.sum()} samples)")
        else:
            print(f"  {cls:12s}: N/A (0 samples)")


if __name__ == "__main__":
    train()
