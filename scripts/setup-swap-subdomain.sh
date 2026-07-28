#!/usr/bin/env bash
# Stand up swap.degentournament.fun. RUN ON PROD (root@sol-pkmn.fun).
#
# BLOCKED UNTIL DNS EXISTS. swap.degentournament.fun currently has no A record; add
#   swap.degentournament.fun.  A  146.190.150.78
# and then run this. Until then the swap page is already live and fully working at
# https://degentournament.fun/swap/ — the subdomain is a nicer address, not a feature.
#
# The vhost is a thin one: same document root, serving the same directory. It exists so
# the subdomain has its own certificate and its own name, NOT a second copy of the page.
set -euo pipefail

DOMAIN=swap.degentournament.fun
ROOT=/var/www/frag-arena/public/swap
CONF=/etc/nginx/sites-enabled/$DOMAIN

if ! getent hosts "$DOMAIN" >/dev/null; then
  echo "ABORT: $DOMAIN does not resolve yet. Add the A record first." >&2
  exit 1
fi

# HTTP first, so the ACME challenge can be answered. NOTE the redirect lives inside
# `location /` — a server-level `return` runs in the rewrite phase, BEFORE nginx picks a
# location, and would swallow the challenge. (Learned the hard way on the apex.)
cat > "$CONF" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
    }
    location / { return 301 https://\$host\$request_uri; }
}
NGINX

nginx -t && systemctl reload nginx

# Its own certificate, named for itself, so the padlock shows the subdomain.
# Deliberately NOT added to the apex cert: the apex is HSTS'd without
# includeSubDomains precisely so this could be stood up independently.
certbot certonly --webroot -w /var/www/certbot --cert-name "$DOMAIN" -d "$DOMAIN" \
  --non-interactive --agree-tos

cat > "$CONF" <<NGINX
server {
    listen [::]:443 ssl;
    listen 443 ssl;
    server_name $DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Serves the SAME directory the apex serves at /swap — one copy of the page, two
    # addresses. Deploying the swap page updates both by construction.
    root $ROOT;
    index index.html;

    add_header Strict-Transport-Security "max-age=15768000" always;
    # config.json carries the live mint and must never be cached at an edge: going live
    # is "edit this file", and a cached copy would keep the page saying PENDING.
    location = /config.json {
        add_header Cache-Control no-store;
        add_header Strict-Transport-Security "max-age=15768000" always;
    }
    location / { try_files \$uri \$uri/ /index.html; }
}

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
    }
    location / { return 301 https://\$host\$request_uri; }
}
NGINX

nginx -t && systemctl reload nginx
echo "done — https://$DOMAIN should now serve the swap page."
