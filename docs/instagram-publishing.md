# Publishing an image to Instagram

Instagram does not take file uploads from XN-Interact. Meta **fetches the JPEG itself from a public URL** when a container is created, so an approved image has to be hosted somewhere public first. XN-Interact keeps that step small and owner-controlled.

## How a post works

1. **Stage** the JPEG (`social_media_upload`, or `--image-file`). Only JPEG is planned: a PNG is refused at plan time, before any approval, because Instagram accepts JPEG only.
2. **Host** it: `xn-interact media host <file>`. This copies the file into a local git checkout (`XN_INTERACT_PUBLIC_MEDIA_DIR`) as `<sha256>.jpg`, commits and pushes. It needs a terminal and your typed confirmation (the first 8 characters of the sha256), because afterwards anyone can fetch the file. XN-Interact cannot undo that.
3. **Plan and approve.** The image URL is never an input: it is `XN_INTERACT_PUBLIC_MEDIA_BASE` + `<sha256>.jpg`, so the plan's content digest names the exact file you approve.
4. **Execute** (the `content.media_publish` workflow):
   - `media.upload`: the adapter first checks that the URL answers 200 with `image/jpeg`; if not, **nothing is sent to Instagram**. Then it creates a container. A container is not visible on Instagram.
   - the workflow polls `GET /<container>?fields=status_code` until `FINISHED` (`ERROR` or `EXPIRED` publishes nothing);
   - `content.publish.image` calls `media_publish`. This is the only step that makes the post visible. A server error here is an unknown outcome and is never retried;
   - read-back looks for an identical caption among the 25 most recent posts.

## Setup

```
# a public repository whose files are served over HTTPS, e.g. raw.githubusercontent.com
git clone <your public media repo> ~/x90-media
export XN_INTERACT_PUBLIC_MEDIA_DIR=~/x90-media
export XN_INTERACT_PUBLIC_MEDIA_BASE=https://raw.githubusercontent.com/<owner>/<repo>/main/   # HTTPS, ends with "/"
```

Set both for the CLI (shell) and for the MCP server (`env` of its entry in `.mcp.json`). Without the base, `content.publish.image` and `media.upload` are `UNSUPPORTED` and say so.

## First post

Instagram image publishing is `UNVERIFIED` until a real approved post worked, like every operation. One command arms the two write steps together, shows the exact plan, takes your approval, publishes and reads back:

```
bun run src/cli.ts media host ~/Pictures/post.jpg
bun run src/cli.ts first-post instagram --text-file caption.txt --image-file ~/Pictures/post.jpg
```

`first-post` refuses early, before any approval, if the image is not served at its public URL yet.

## Limits worth knowing

- The adapter cannot verify the bytes at the public URL (the provider transport is text-only); it checks reachability and content type, and the file name carries the sha256. Use a host you control.
- Captions: at most 2,200 characters. At most 100 API-published posts per 24 hours (Meta's limit). One image per post; carousels, reels and stories are not implemented.
- The post is public and the gateway has no delete permission: remove a test post in the Instagram app.
- Standing grants and evidence signoffs do not cover images: every Instagram post needs the owner's approval (threat T26).
