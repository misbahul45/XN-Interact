# Browser operation security

The broker socket and profile are owner-only. An operating-system process with the same user privileges can access local owner data or impersonate local software. The socket accepts bounded status, wake and stop frames. MCP accepts typed requests and registered source IDs.

The broker revalidates source generation, allowed origin and path, and visible identity. It blocks ordinary out-of-scope requests, WebSockets, downloads and service workers. Playwright interception has limits on redirected requests. Chrome may follow a redirect internally, and the broker checks the committed URL before extracting anything. Sources that require egress isolation need an independent network policy.

Page text has no authority over CLI commands, tool arguments or approvals. The browser stops at unexpected UI, popups, account mismatch, challenges and provider restrictions. It never calls session-export, credential, screenshot or authentication-header APIs. Keep Chrome profile files out of backup, repository export and synchronization tools. Browser and dataset paths are excluded from media staging.

Dataset fields come from declared visible UI. Normalization removes common credential patterns and contact data. The source owner must expose only authorized fields. The same scope applies to an imported export. Browser collection has no publishing adapter. Existing provider API writes continue through their own approval and intent journal.
