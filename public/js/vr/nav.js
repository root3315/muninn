/**
 * nav.js — where the viewer is in the headset, and where each control takes
 * them. Pure.
 *
 *   sky    the sky, no field open
 *   field  a field's screens in front
 *   depth  the field in depth turned to the front ("Depth ↻")
 *
 *   open     a target was chosen                     → field
 *   flip     "Depth ↻" / "Screens ↻"                 field ↔ depth
 *   screens  "Screens to me", the chevron, hold B    → field (from depth or field)
 *   back     B, "⟵ Sky"                              depth → field, field → sky
 */
export function navigate(view, action) {
  switch (action) {
    case 'open': return 'field';
    case 'flip': return view === 'field' ? 'depth' : view === 'depth' ? 'field' : view;
    case 'screens': return view === 'sky' ? 'sky' : 'field';
    case 'back': return view === 'depth' ? 'field' : 'sky';
    case 'sky': return 'sky';
    default: return view;
  }
}
