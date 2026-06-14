# Contributing to MyAgent

Thanks for your interest in contributing!

## Licensing of contributions (important)

MyAgent is **dual-licensed** under the AGPL-3.0 **and** a separate commercial
license (see [LICENSING.md](./LICENSING.md)). For the maintainer to be able to
offer the project under both licenses, the maintainer must hold sufficient
rights to **all** code in the project.

Therefore, **before any contribution can be merged, you must agree to a
Contributor License Agreement (CLA).** By submitting a contribution (pull
request, patch, or otherwise), you agree that:

1. You are the original author of the contribution, or you have the right to
   submit it.
2. You grant the maintainer the right to license your contribution under **both**
   the AGPL-3.0 **and** the commercial license, including the right to
   relicense it as part of the project's dual-licensing model.
3. Your contribution does not knowingly include code under a license
   incompatible with the above (e.g. GPL/AGPL code you do not own, or
   proprietary code).

> A formal CLA process (e.g. CLA Assistant) will gate pull requests. If one is
> not yet wired up, the maintainer may ask you to confirm the above in writing
> on your PR before merging. These terms will be finalized with legal review;
> they are summarized here so the intent is clear up front.

If you cannot agree to the CLA, you are still completely free to use, modify,
and fork MyAgent under the AGPL-3.0 — the CLA only applies to contributions
merged back into this project.

## How to contribute

1. Open an issue describing the change before large work, so we can align.
2. Keep changes focused; match the surrounding code style.
3. Run the checks before opening a PR:
   - `npm run typecheck`
   - `npm test`
   - `npm run test:e2e` (where relevant)
4. Reference any related issue in the PR description.
