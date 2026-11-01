# Dependency patches

`lemmascript@0.6.5.patch` imports the CLI's package version as JSON instead of
reading it through a disk URL. The compiled verifier's `info --typed` command
needs that version; its original URL points outside Bun's embedded filesystem.
Extraction, configuration and verification remain owned by LemmaScript.

Bun applies the pinned patch during installation. The compiled binary tests
exercise both typed metadata and proof-scope evidence outside the checkout.
Remove this patch when the adopted LemmaScript release imports its version
without requiring that disk path. Its MIT notice is retained in `NOTICE`.
