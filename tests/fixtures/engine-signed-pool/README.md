# Offline signed-transport fixture

The self-signed certificate and private key are public synthetic TEST material.
SANs: api.gateio.ws, localhost, 127.0.0.1. Never install these into a deployment.
Only the child fixture process trusts this CA via NODE_EXTRA_CA_CERTS.

runner.ts uses fixed offline credentials against loopback TLS/CONNECT servers.
It always passes explicit fake SDK keys and never contacts an external account API. Its two rounds
of eight delayed responses are a transport stress check, not a live baseline.
