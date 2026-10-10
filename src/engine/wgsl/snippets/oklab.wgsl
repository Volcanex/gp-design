// Ottosson OKLab <-> linear sRGB, constants exactly as in
// src/app/mock/mock-color.ts (oklabToSrgbCss). https://bottosson.github.io/posts/oklab/

fn oklab_to_linear_srgb(lab: vec3f) -> vec3f {
  let L = lab.x;
  let a = lab.y;
  let b = lab.z;
  let l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  let m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  let s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  );
}

fn linear_srgb_to_oklab(rgb: vec3f) -> vec3f {
  let r = rgb.x;
  let g = rgb.y;
  let b = rgb.z;
  let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  let l_ = cbrt(l);
  let m_ = cbrt(m);
  let s_ = cbrt(s);
  return vec3f(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  );
}

fn oklab_to_oklch(lab: vec3f) -> vec3f {
  let c = sqrt(lab.y * lab.y + lab.z * lab.z);
  let h = atan2(lab.z, lab.y);
  return vec3f(lab.x, c, h);
}

fn oklch_to_oklab(lch: vec3f) -> vec3f {
  return vec3f(lch.x, lch.y * cos(lch.z), lch.y * sin(lch.z));
}

// Linear sRGB -> XYZ(D65) -> linear Display P3, combined into one matrix.
// XYZ(D65) matrices are the standard sRGB/P3 primaries (IEC 61966-2-1 /
// SMPTE RP 431-2, D65 white); combined here as the CSS Color 4 spec's
// lin_sRGB_to_lin_P3 (matches colorjs.io).
fn linear_srgb_to_linear_p3(rgb: vec3f) -> vec3f {
  let r = rgb.x;
  let g = rgb.y;
  let b = rgb.z;
  return vec3f(
    0.8224621925 * r + 0.1775380075 * g + 0.0000000000 * b,
    0.0331941989 * r + 0.9668058011 * g + 0.0000000000 * b,
    0.0170827899 * r + 0.0723974408 * g + 0.9105197794 * b,
  );
}
