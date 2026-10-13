/**
 * Chart colours for the dashboard. The UI chrome is Edapt's black and white; data marks use the documented,
 * validated reference palette from the dataviz method (validated on the app's white surface: slots 1 and 2 pass
 * lightness, chroma, CVD and contrast; worst adjacent CVD delta E 24.7). The app has no dark mode yet, so only the
 * light steps are used.
 *
 * Rules: categorical slots are assigned in this fixed order and follow the entity, never its rank; text never wears
 * a data colour (labels use the ink tokens); context marks (the period being compared against, "not yet paid")
 * wear the recessive gray, so the current period is the only loud thing.
 */
export const VIZ = {
  /** slot 1, blue: the current period / the main series */
  series1: "#2a78d6",
  /** slot 2, orange: the second category when two must be told apart (self-serve vs assisted) */
  series2: "#eb6834",
  /** de-emphasis gray for context marks (relief: every chart has a table view and labels) */
  context: "#c3c2b7",
  /** lighter step of the blue ramp, for meter tracks */
  track: "#cde2fb",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  /** muted ink for axis ticks */
  tick: "#6b6b66",
  ink: "#111111",
  surface: "#ffffff",
} as const;
