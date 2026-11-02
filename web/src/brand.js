// Adopted by the owner: concept 04, Orbit Media (2026-10-21).
export const BRAND_ASSETS=Object.freeze({mark:'/brand/orbit-mark.svg',inverse:'/brand/orbit-mark-inverse.svg',icon:'/brand/orbit-icon.svg'});
// The link/container owns the accessible name; images are decorative.
export function brandMarkup(){
  return '<img class="brand-symbol brand-symbol-light" src="'+BRAND_ASSETS.mark+'" alt="" width="44" height="27" decoding="async"><img class="brand-symbol brand-symbol-dark" src="'+BRAND_ASSETS.inverse+'" alt="" width="44" height="27" decoding="async"><span class="brand-wordmark" aria-hidden="true">Mirea</span>';
}
