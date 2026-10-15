# Content classification

Every catalog entry is classified before it can appear in the Store, whether
or not adult content is enabled. The NSFW setting only changes visibility.

## How a rating is decided

Inputs (`src/main/classification.ts`, `src/shared/policy.ts`):

1. **Images** — the cover and up to four screenshots are scored by
   [vit-base-nsfw-detector](https://huggingface.co/AdamCodd/vit-base-nsfw-detector)
   (ViT-B/16 at 384 px, fp16 ONNX, Apache-2.0). A score ≥ 0.5 is adult.
2. **Text** — title, description and tags are matched against adult-content
   terms (e.g. *NSFW*, *hentai*, *explicit sexual*, *adults only*, *18+*).
3. **Site labels** — RTA labels, adult `rating` meta tags, JSON-LD
   `contentRating`, itch.io NSFW tags and content warnings, and age gates.

Any adult evidence makes the entry `adult`. It is `safe` only if its cover was
classified successfully and nothing flagged it. If the cover cannot be fetched
or decoded, the entry stays `unknown` — hidden in both modes — and is retried.
Screenshots are additionally gated one by one: an adult-scoring screenshot of
an otherwise safe game is never shown while NSFW is off.

In the Store browser drawer, with NSFW off, each frame is shown only after the
whole frame and every visible image region pass; unknown or failed checks mask
the frame. Pages of entries rated adult, and pages carrying adult labels, are
masked outright.

## Measured results

Measured on 2026-10-12 with `scripts/eval-classifier.mjs`, which runs the same
preprocessing as the app. Threshold 0.5, the earlier int8 model, 4 CPU threads (these figures predate the switch to fp16 in 0.2.0, which matches the fp32 reference more closely).

**Safe images (false-positive rate):**

| Style | Images | Flagged as adult | False-positive rate |
|---|---:|---:|---:|
| Photographs (landscape/nature) | 17 | 0 | 0.0 % |
| Illustration (western, painterly, ink) | 26 | 1 | 3.8 % |
| Anime / visual-novel art | 17 | 1 | 5.9 % |
| Pixel art | 21 | 1 | 4.8 % |
| **All** | **81** | **3** | **3.7 %** |

Threshold sweep over the same set: 0.3 → 4.9 %, 0.6 → 3.7 %, 0.7 → 2.5 %,
0.8 → 1.2 %. Latency: median 405 ms, p95 550 ms per image.

Sources: stock desktop wallpapers (photographs) and itch.io store covers from
the default (non-NSFW) listings, hand-labelled by style.

### Observed limitations

- **Blood and gore read as adult.** All three false positives were horror covers
  dominated by red, with blood or gore and no nudity. Horror games are therefore
  hidden more often than necessary while NSFW is off.
- **The model is deliberately restrictive.** Per its model card, suggestive
  images (cleavage, swimwear) count as NSFW. Expect some non-explicit games to be
  hidden.
- **"18+" text is a strong signal.** Games that say "18+" because of violence
  are hidden too.
- **Generated (AI) images are weaker.** The model card reports accuracy falling
  from 96.5 % to 86 % on generated images.
- **Photographs of people were not in the local set.** The photo results above
  cover landscapes only; skin-heavy photos are the classic source of both false
  positives and misses.
- **Adult recall was not measured locally.** No labelled adult image set is
  bundled. The model card reports 96.5 % accuracy (AUC 0.995) on mixed drawings
  and photos. Maintainers should measure recall with their own labelled set:

  ```bash
  node scripts/eval-classifier.mjs /path/to/dataset --json results.json
  ```

  with `dataset/{safe,adult}/{photo,illustration,anime,pixel}/*.jpg`.
- **Whole-frame checks are coarse.** Browser snapshots are scored as a whole
  and per visible image; adult content drawn into a canvas or CSS backgrounds
  is only covered by the whole-frame score.

Classification is automatic and imperfect. Treat it as a filter that reduces
exposure, not as a guarantee.
