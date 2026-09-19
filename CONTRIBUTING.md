# Contributing

Contributions to integrations, task examples, experiments, documentation and implementation are welcome.

## Development

Use Node.js 24+ and `npm ci`. Run these checks for implementation changes:

```sh
npm run check
npm run check:docs
npm run check:package
```

Jev handles semantic decisions; code handles execution, explicit constraints and accounting. Keep the decision loop small and reuse the existing Router, host and storage interfaces.

Version changes to decision questions, evaluation criteria and embedding models. Cover failure handling, missing usage, isolation and persistence with deterministic providers. Keep paid model experiments separate from local checks.

## Pull requests

Repository access is not required to contribute. Fork the repository, create a focused branch from the latest `main`, and open a pull request back to `MobAI-Inc/Cynosure`.

Keep each pull request scoped to one change and use the pull request template to describe the problem, behavior change and validation. Run the relevant checks before requesting review; documentation-only changes should at least pass `npm run check:docs`.

## Documentation

Use the [documentation map](docs/README.md) and update the current page for each topic. The [project introduction](docs/overview.md) explains the product; [experiment results](docs/validation.md) describe measured outcomes and their scope. Keep user documentation focused on capabilities, usage and concrete results. State unvalidated claims briefly and precisely.

When adding experiment results, update the [data summary](docs/benchmarks/evidence.json) from the raw analyses and record their SHA-256 digests. Keep trial denominators, billing sources and excluded records traceable. Upstream references use fixed commits in the [source catalog](docs/research/sources.json).

Run `npm run check:docs` after documentation changes. See the [roadmap](ROADMAP.md) for contribution areas.

## Data and licensing

Do not commit credentials, private task traces or local databases. Follow the [security guidance](SECURITY.md) and preserve copyright and Apache-2.0 notices.
