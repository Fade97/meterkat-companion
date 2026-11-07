# Meterkat companion 1.5.0

**New desktop design (UI v2), the same design language as the Android app:**
- Each limit shows used or left in percent, a tick for the elapsed share of its window, and pace in three steps: *On pace*, *Cutting it close*, *▲ Runs out in …*.
- The limit most at risk leads in a headline card, with *Also at risk* below it.
- The window and island headers name stale data and needed sign-ins (e.g. *Codex sign-in needed*, *All stale · 15m ago*). Stale rows are dimmed, marked *Low when last seen* and left out of the ranking.
- The overview fits a 460×720 window; contrast, target sizes and clipping are checked automatically.

**Hosted relay on its new address:** existing registrations move to `https://relay.meterkat.fdu.gg` (staging `https://relay-staging.meterkat.fdu.gg`) on the next start. It is the same relay: the source, its credentials and paired phones stay as they are, and no re-pairing is needed. New pairing links carry the new address; Meterkat for Android 1.1.1 and older refuses them until **Advanced: custom relay** allows `https://relay.meterkat.fdu.gg`.
