# @commerceworker/cli

> A private workspace package. It ships on npm inside [`@commerceworker/sdk`](../sdk/sdk/README.md) as its `commerceworker` binary; the examples below use that name.

The `commerceworker` command: sign in to a workspace, keep the content model in a file, read and
write entries, upload assets, import files and generate types. Every command takes `--json` for
scripts and agents. Node 24 or later.

```sh
npm install -D @commerceworker/sdk

npx commerceworker login --url https://api.your-workspace.commerceworker.com
npx commerceworker doctor
npx commerceworker model export --out content-model.ts
npx commerceworker model apply content-model.ts --dry-run
npx commerceworker entries list --content-type article --json
npx commerceworker import posts.xml --content-type article --map title=title --map body=content --dry-run
npx commerceworker types --out src/generated/content-types.ts
```

In CI, set `COMMERCEWORKER_TOKEN` and `COMMERCEWORKER_URL` instead of logging in. Exit codes: 0 ok,
1 failed, 2 usage or confirmation needed (it never prompts off a terminal; pass `--yes`), 3 not
signed in, 4 destructive model change refused (`--allow-destructive`).

Every command and option: https://docs.commerceworker.com/content/guides/cli/. Skills that teach a coding
agent to use it: https://docs.commerceworker.com/content/guides/agent-skills/.
