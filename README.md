# glen-charts

A shared library for no-LLM data explorer apps on the GLEN architecture: fixed, reviewable SQL templates over H3-indexed GeoParquet, run on the duckdb MCP server or in the browser with DuckDB-wasm, rendered as maps, charts and exportable reports.

**Status: design only.** No code has moved here yet. [DESIGN.md](DESIGN.md) sets out what the library will contain, its extension points and the migration plan.

Built from two apps:

- [tpl-cities](https://github.com/boettiger-lab/tpl-cities): California community profiles, with an MCP site and an in-browser (DuckDB-wasm) variant.
- [ca-30x30 Assessment Explorer](https://github.com/boettiger-lab/ca-30x30/tree/main/assessment): the 2025 30x30 Biodiversity Assessment for any area of California.

The LLM-driven counterpart is [geo-agent](https://github.com/boettiger-lab/geo-agent); the two libraries are separate.

## License

BSD 2-Clause; see [LICENSE](LICENSE).
