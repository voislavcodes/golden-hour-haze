// Shared wetness calculation — used by brush, scrape, wipe, compositor
// Paint state texture: R = session-relative seconds when painted, G = thinners at time of painting

fn calculate_wetness(paint_time: f32, current_time: f32, dry_speed: f32, paint_thinners: f32) -> f32 {
  if (paint_time <= 0.0) { return 0.0; }  // never painted
  let age = current_time - paint_time;
  let thinners_dry_boost = 1.0 + paint_thinners * 2.0;
  let adjusted_age = age * dry_speed * thinners_dry_boost;
  // 0-90s wet, 90-300s tacky, 300-900s set, 900s+ dry
  if (adjusted_age < 90.0) { return mix(1.0, 0.5, adjusted_age / 90.0); }
  if (adjusted_age < 300.0) { return mix(0.5, 0.1, (adjusted_age - 90.0) / 210.0); }
  if (adjusted_age < 900.0) { return mix(0.1, 0.02, (adjusted_age - 300.0) / 600.0); }
  return 0.02;
}
