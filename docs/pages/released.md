# Released Label Plugin

This plugin

- comments on the merged PR with the new version
- comments on closed issues with the new version
- adds a `released` label to the pull request
- adds a `released` label to closed issues

::: message is-warning
Make sure that you create the `released` label on you project
:::

## Usage

To use the plugin include it in your `.autorc`

```json
{
  "plugins": ["npm", "released"]
}
```

## Options

### Label

Customize the label this plugin attaches to merged pull requests.

```json
{
  "plugins": [
    "npm",
    [
      "released",
      {
        "label": ":shipit:"
      }
    ]
  ]
}
```

### Message

To customize the message this plugin uses on issues and pull requests use the following format.

- `%TYPE` - Either `PR` or `Issue`
- `%VERSION` - The version that was just published

```json
{
  "plugins": [
    "npm",
    [
      "released",
      {
        "message": "%TYPE went out with version: %VERSION"
      }
    ]
  ]
}
```

### Lock Issue

Lock issues that have been merged in PRs.

```json
{
  "plugins": ["npm", ["released", { "lockIssues": true }]]
}
```
