# node-red-contrib-gh

Runs the installed [GitHub CLI](https://cli.github.com/) (`gh`) from a
Node-RED flow. One `gh` invocation per incoming message, no shell involved.

## Prerequisites

`gh` must already be installed and authenticated on the Node-RED host:

```bash
gh --version
gh auth login          # or GH_TOKEN / GH_ENTERPRISE_TOKEN in the environment
```

This package does not bundle `gh` or implement its own login flow.

## Node: `gh`

**Inputs:** 1 &nbsp; **Outputs:** 1

| Field              | Type                | Notes                                                                                                                                                                                            |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Command            | str/msg/flow/global | The `gh` subcommand, e.g. `pr`, `issue`, `workflow`, `api`. Not the full command line -- `gh` itself is always the executable and can never be overridden.                                       |
| Arguments          | str/msg/flow/global | Everything after the command, e.g. `list --state open --json number,title,url`. A string value is tokenized (quote-aware, no shell evaluation); an array value (e.g. from `msg.`) is used as-is. |
| Repository         | str/msg/flow/global | Optional `owner/repo`. Sets `GH_REPO` for the invocation.                                                                                                                                        |
| Host (Advanced)    | str                 | Optional GitHub Enterprise hostname, e.g. `github.example.com`. Sets `GH_HOST`.                                                                                                                  |
| Timeout (Advanced) | number (ms)         | Default 60000. The child process is killed (`SIGTERM`) if it runs longer than this.                                                                                                              |

### `msg.gh` overrides

```js
msg.gh = {
  command: "issue",
  args: ["list", "--state", "open"], // array preferred; skips parsing entirely
  repo: "owner/repo",
  host: "github.example.com",
};
```

Any property present on `msg.gh` takes precedence over the node's own
configuration for that message.

### Output

- `msg.payload`: parsed JSON if stdout was valid JSON, otherwise the raw
  stdout string.
- `msg.gh`: `{ command, args, repo, host, exitCode, stderr }` execution
  metadata. Never contains credentials.

A non-zero exit code, a timeout, or a missing `gh` executable all go through
`done(error)` (catchable with a Catch node) instead of producing an output
message.

## Example

See `examples/list-pull-requests.json` and `examples/run-workflow.json` for
importable flow snippets.

## Tests

```bash
npm test
```

Uses Node's built-in test runner (`node --test`) against a fake `gh`
executable in `test/fixtures/` -- no real GitHub CLI or network access
required.

## Security

- The executable is always the literal string `gh`; nothing in `msg` or
  config can change it.
- No shell is used (`shell: false`); arguments are passed as an array.
- Credentials are never logged, included in `msg`, or included in errors.
- The full process environment is never dumped anywhere.
