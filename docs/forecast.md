# Usage forecast

The desktop app's **Forecast** tab and `meterkat forecast` show, for every current quota window, the expected share at the
reset or the time it runs out, the likely range, and what that is based on. The Meterkat Android app uses the same model on
the readings it receives.

## History

Every sync (once a minute) adds the readings to `usage-history.tsv` in the state directory (private, `0600`): one series per
provider, account fingerprint and window, with time, share used and reset time. Nothing else, and nothing of it is uploaded.
A reading is kept when the share or the reset changed (at most every 5 minutes); a quiet run keeps its first reading, one per
hour and the latest. Readings older than 35 days are dropped. `meterkat delete` removes the file with the other local state.

## Model (`src/forecast.ts`)

The rate (share per hour) at a future moment is the usual rate at that hour of the week, scaled by how busy the current window
has been, plus the current activity's difference from the usual rate, fading out over a persistence time:

`rate(t) = max(0, f · usual(hour of week) + a · e^(−(t − now)/τ))`

- **usual**: usage per observed hour for each hour of the week, weighted by age (half-life 14 days), shrunk where little was
  observed: hour of week → weekday/weekend hour → hour of day → overall rate → the window's own pace.
- **f = 1 − s + s · busy**, busy = this window's usage so far against the usual rates over the same hours (0.25–4).
- **a**: the rate of the last two hours minus the usual rate for them.

21 candidates (τ ∈ {0, 0.5, 1, 2, 4, 12 h, ∞} × s ∈ {0, 0.5, 1}) plus the linear window pace are backtested on the history with
a rolling origin (each test forecast sees only the readings before it); the smallest mean miss wins. The range is the 10th to
90th percentile of the winner's misses at similar horizons, always holding the expected value, widened for the few independent
windows they come from (Student's t). Until 24 hours are observed the forecast follows the window's pace.

Accuracy on simulated users (tests/forecast.test.ts; mean miss at the reset): weekly windows about 5 points against about 17
for the linear pace, five-hour windows about 5 against 15.
