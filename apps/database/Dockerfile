FROM postgres:18.6-alpine3.23

RUN apk upgrade --no-cache \
    && rm -f /usr/local/bin/gosu

USER postgres
