---
name: gcs-static-hosting
description: Host static HTML files, playgrounds, tools, and docs on Google Cloud Storage for internal Spotify access. Use when the user wants to host a static site, share an interactive tool internally, or create a simple internal web page without deploying a full service.
---

# GCS Static Hosting at Spotify

Host static HTML files (playgrounds, tools, docs) on Google Cloud Storage for internal Spotify access.

## When to use this skill

When the user wants to:

- Host a static HTML file or site for teammates to access
- Share an interactive playground or tool internally
- Create a simple internal web page without deploying a full service

## Spotify-Specific Constraints

**Org policies block public access:**

- `allUsers` is blocked by `custom.denyPrincipalAllUsers`
- `allAuthenticatedUsers` is blocked by `custom.denyPrincipalAllAuthenticatedUsers`

**Use domain-based access instead:**

- `domain:spotify.com` grants access to all Spotify employees with Google accounts
- Users must be logged into their Spotify Google account to view

## Workflow

### 1. Choose a GCP project

Ask the user which GCP project to use, or use the project related to the content being hosted.

### 2. Create the bucket

```bash
gcloud storage buckets create gs://BUCKET_NAME --location=europe-west1 --uniform-bucket-level-access
```

Naming conventions:

- Use descriptive names: `team-tool-name` (e.g., `babka-druid-tools`)
- Keep it lowercase with hyphens

### 3. Upload files

```bash
# Single HTML file
gcloud storage cp index.html gs://BUCKET_NAME/index.html --content-type="text/html"

# Multiple files
gcloud storage cp -r ./site/* gs://BUCKET_NAME/
```

Always set appropriate content types:

- `.html` → `text/html`
- `.css` → `text/css`
- `.js` → `application/javascript`
- `.json` → `application/json`

### 4. Grant Spotify domain access

```bash
gcloud storage buckets add-iam-policy-binding gs://BUCKET_NAME \
  --member="domain:spotify.com" \
  --role=roles/storage.objectViewer
```

### 5. Configure static website hosting (optional)

```bash
gcloud storage buckets update gs://BUCKET_NAME --web-main-page-suffix=index.html
```

### 6. Provide the URL

**For authenticated access (Spotify employees):**

```
https://storage.cloud.google.com/BUCKET_NAME/index.html
```

This URL will prompt for Google authentication if needed.

**Note:** The `storage.googleapis.com` URL won't work because public access is blocked.

## Complete Example

```bash
# Set project
gcloud config set project my-project

# Create bucket
gcloud storage buckets create gs://my-team-tools --location=europe-west1 --uniform-bucket-level-access

# Upload
gcloud storage cp index.html gs://my-team-tools/index.html --content-type="text/html"

# Grant Spotify access
gcloud storage buckets add-iam-policy-binding gs://my-team-tools \
  --member="domain:spotify.com" \
  --role=roles/storage.objectViewer

# Configure index
gcloud storage buckets update gs://my-team-tools --web-main-page-suffix=index.html

# Done! URL:
echo "https://storage.cloud.google.com/my-team-tools/index.html"
```

## Updating content

To update the hosted file:

```bash
gcloud storage cp index.html gs://BUCKET_NAME/index.html --content-type="text/html"
```

Changes are reflected immediately (no cache by default).

## Troubleshooting

**403 Forbidden:**

- User isn't logged into their Spotify Google account
- Domain binding wasn't applied - check with: `gcloud storage buckets get-iam-policy gs://BUCKET_NAME`

**Bucket creation fails:**

- Check you have permission in the GCP project
- Bucket names are globally unique - try a more specific name

**Content-Type issues (file downloads instead of displays):**

- Re-upload with explicit `--content-type="text/html"`
