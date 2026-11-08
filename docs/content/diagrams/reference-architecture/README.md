# Reference architecture diagrams

Mermaid sources for [Reference architecture](../../reference-architecture.md), each with the SVG
rendered from it. The page holds the prose: every numbered callout (①, ②, …) and what each
diagram leaves out. Each source carries an `accTitle` and an `accDescr`, the paragraph a reader
gets if the image fails to load.

| File                     | Type            | Detail   | Labeled nodes |
| ------------------------ | --------------- | -------- | ------------- |
| `overview.mmd`           | flowchart       | faithful | 22 of 24      |
| `publish-to-deliver.mmd` | sequenceDiagram | balanced | 11 of 12      |
| `delivery-read.mmd`      | flowchart       | balanced | 11 of 12      |
| `asset-pipeline.mmd`     | flowchart       | balanced | 12 of 12      |

Change a source and both its SVGs in the same commit, and the page's callout text if a callout moved.

## Checking and rendering

The diagrams draw in the workflow canvas's language from Ledger's tokens: `node` boxes with
`edge` borders and lines on `paper`, `sheet` groups and `ink` words. One accent, Ledger's purple
`brand`, sits on the focal nodes and the shaded sequence block only. Each diagram ships as a light
and a dark SVG, and the page picks one with `<picture>` and `prefers-color-scheme`. Sources carry
no colours: `classDef`s set only stroke weight, dashes and bold. The themes in `../themes/` are
generated from `packages/design` (`src/mermaid.ts`) by `pnpm sync:theme`, which is also how a
token change reaches them; re-render after it. packages/design's tests hold the themes current
and check their contrast.

```sh
# lint and slop need the marmalade Claude Code plugin; rendering needs only Node
P=~/.claude/plugins/cache/marmalade/marmalade/0.1.3/scripts
python3 $P/marmalade_lint.py docs/diagrams/reference-architecture
python3 $P/marmalade_slop.py docs/diagrams/reference-architecture/overview.mmd --detail faithful
python3 $P/marmalade_slop.py docs/diagrams/reference-architecture/{publish-to-deliver,delivery-read,asset-pipeline}.mmd --detail balanced
cd docs/diagrams/reference-architecture
for n in overview publish-to-deliver delivery-read asset-pipeline; do for m in light dark; do
  npx @mermaid-js/mermaid-cli -i $n.mmd -o $n.$m.svg -c ../themes/ledger-$m.json -b transparent
done; done
```

The rubric scores `publish-to-deliver.mmd` 82 with one SLOP001, and that finding is a counting
artifact, not a real overage. The slop checker's node counter is written for flowcharts. It
counts each sequence arrow's source as an extra id (`Api-` from `Api->>`, `Api--` from
`Api-->>`) and the `rgb(` of the focal `rect` as a node. Its own vetted `sequence.mmd` template,
which has three participants, counts as 7 nodes. The diagram has 11 participants against a budget
of 12.

`title`, `accTitle` and `accDescr` write `{domain}` rather than `<domain>`. Mermaid renders those
fields as text, so an HTML entity shows up literally and a raw `<domain>` is dropped as a tag.
