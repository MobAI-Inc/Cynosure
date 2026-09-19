# Security

Do not commit credentials, local databases or private task traces. Provider keys are read from environment variables; redirects are rejected and HTTPS is required except for loopback testing. Provider diagnostics avoid echoing authentication or arbitrary error bodies.

Experience contains actual prompts and outputs. Protect the local data directory and bind each trusted caller to its own scope. Scope filtering is not authentication. The CLI has no public network listener. The deployed Mob AI Router host authenticates before dispatch and stores each API key’s history in a separate Durable Object; archive downloads require the owning key. Administrative history import additionally requires a temporary migration secret, removed after verification. Other HTTP hosts must enforce identity and permissions before calling the library.

Model output is untrusted. Finite Choice answers are validated and all paid calls reserve budget. The text CLI does not execute code or tools; the Pi extension returns only the selected proposal to Pi, whose permissions and tool execution remain authoritative. Model judgments cannot grant permissions or guarantee correctness. Report vulnerabilities privately to the repository maintainers rather than including sensitive data in public issues.
