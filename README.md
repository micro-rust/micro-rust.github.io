# micro-rust.github.io

Personal programming blog, built with [Zola](https://www.getzola.org) and published on GitHub Pages.

Zola is a single self-contained binary: no Node, no npm, no package manager, no dependency tree.
The deploy workflow downloads a pinned Zola release and verifies its SHA-256 before running it,
and every GitHub Action is pinned to a full commit SHA.

## Structure

```
content/posts/        Your posts: one Markdown file per post
content/posts/_index.md  Settings for the post list (sorting, title)
sass/_theme.scss      Colors, fonts and sizes for dark and light mode
sass/style.scss       The rest of the styling
static/               Copied as-is to the site (images, JS, favicon...)
templates/            HTML layout (Tera templates)
zola.toml             Site settings (title, URL, Markdown options, highlighting theme)
.github/workflows/    Deploy workflow (runs on every push to main)
public/               Generated output (git-ignored)
```

## Writing a post

Create `content/posts/my-post.md`. The file name becomes the URL (`/posts/my-post/`).

```markdown
+++
title = "My post title"
date = 2026-09-23
description = "One line shown in the post list."
draft = true            # optional: keeps the post out of the published site

[taxonomies]
tags = ["rust", "embedded"]
+++

Your Markdown here.
```

`title` and `date` are required. A post without a `date` is skipped by Zola, so the
deploy workflow fails with an error rather than publishing without it.

Markdown supports tables, footnotes, nested lists, syntax-highlighted code blocks and
GitHub-style callouts (`> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`...). Code blocks accept
extras such as ` ```rust,linenos,hl_lines=2-3,name=main.rs `.

**Images:** put a post in its own folder to keep its images next to it:

```
content/posts/my-post/index.md
content/posts/my-post/diagram.png   -> ![Diagram](diagram.png)
```

Or put shared images in `static/img/` and link them as `/img/name.png`.

## Previewing locally

1. Download Zola from the [releases page](https://github.com/getzola/zola/releases)
   (Windows: `zola-vX.Y.Z-x86_64-pc-windows-msvc.zip`), ideally the same version as
   `ZOLA_VERSION` in the workflow, and put `zola.exe` somewhere on your `PATH`.
   To verify it, compare `Get-FileHash zola-*.zip` (PowerShell) with the `sha256` digest
   shown on the release page.
2. From the repo root run:

   ```
   zola serve --drafts
   ```

   and open http://127.0.0.1:1111. It reloads on every save; `--drafts` also shows draft posts.

## Changing the style

- **Colors, fonts, content width:** `sass/_theme.scss`. `:root` is the dark theme (the default),
  `:root[data-theme="light"]` is the light one.
- **Layout and components:** `sass/style.scss` (SCSS, compiled by Zola, no tooling needed).
- **Code highlighting colors:** `light_theme` / `dark_theme` in `zola.toml`
  ([theme gallery](https://textmate-grammars-themes.netlify.app/)).
- **HTML structure (header, nav, footer, post page):** `templates/`. Site title, tagline and
  links live in `zola.toml` (`title`, `description`, `[extra]`).

The header's theme button switches between dark and light and remembers the choice (`static/js/theme.js`).

## Publishing: every push to `main` deploys

One-time setup on GitHub:

1. Create the repository **`micro-rust.github.io`** under the `micro-rust` account/org
   (the name must be `<owner>.github.io` for the site to live at `https://micro-rust.github.io/`),
   and push this repo to it.
2. In the repo, open **Settings > Pages**.
3. Under **Build and deployment > Source**, select **GitHub Actions**.
4. Push to `main` (or open the **Actions** tab, pick *Deploy blog to GitHub Pages* and click
   **Run workflow**).

From then on, every push to `main` builds and publishes the site in about a minute. Progress and
errors show in the **Actions** tab. If the deploy job fails with an environment protection
error, go to **Settings > Environments > github-pages** and allow the `main` branch.

## Upgrading the pinned versions

- **Zola:** in `.github/workflows/deploy.yml`, set `ZOLA_VERSION` to a release that is at least
  a week old and `ZOLA_SHA256` to the digest of its `x86_64-unknown-linux-gnu.tar.gz` asset.
  Read the release notes first: Zola is pre-1.0 and occasionally has breaking changes.
- **Actions:** replace each `@<sha> # vX.Y.Z` with the commit SHA of a newer tag.
  Optionally, add a Dependabot config for `github-actions` to get these as PRs.
