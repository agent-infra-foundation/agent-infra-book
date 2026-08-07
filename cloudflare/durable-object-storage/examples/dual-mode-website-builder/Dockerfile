# The container is the expensive compatibility fallback. computerd is PID 1
# and projects the durable Workspace into Linux at /workspace.
FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.1 AS computerd

FROM node:22-bookworm-slim

# Node and npm come from the pinned base image. Only the FUSE runtime and Git
# are added here; the isolate handles ordinary file creation and inspection.
RUN apt-get -o Acquire::Retries=5 update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2 ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
