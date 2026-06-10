# Derived iron-proxy that additionally trusts this deployment's firewall CA
# for UPSTREAM verification — needed so the in-cluster llm-mock (serving a
# firewall-CA-signed cert on :443) passes the proxy's upstream TLS check.
# Build context must contain fw-ca.crt (extracted from the
# centaur-firewall-ca secret). Local-dev fixture only.
FROM centaur-iron-proxy:latest
USER root
COPY fw-ca.crt /usr/local/share/ca-certificates/centaur-fw-ca.crt
RUN cat /usr/local/share/ca-certificates/centaur-fw-ca.crt >> /etc/ssl/certs/ca-certificates.crt
