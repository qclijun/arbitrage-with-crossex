# Synthetic TLS fixture

This self-signed certificate and test-only private key serve the local CONNECT
regression test. They are synthetic, have no production use or account access,
and are trusted only by the isolated test child via `NODE_EXTRA_CA_CERTS`.
