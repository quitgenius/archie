'use strict';

// ECR lookups for the agent image.
//
// VALIDATION IS THE POINT. A bad pointer does not fail loudly — it provisions runtimes that cannot
// pull, so every agent breaks on its next message with a create failure rather than an obvious error
// at publish time. So publishing refuses unless the tag EXISTS and is arm64: AgentCore microVMs are
// arm64, and an amd64 image in the agent repo is the single easiest mistake to make here (the
// dispatcher image is amd64 and built from the same tree, minutes apart).

const { preflight, refused } = require('./exit');

/**
 * What ECR holds for this tag, or null.
 *
 * Absence is a clean null — the caller decides whether that means "build it" or "refuse".
 */
async function describeImage(aws, { account, repo, tag }) {
  const { DescribeImagesCommand, BatchGetImageCommand } = require('@aws-sdk/client-ecr');
  let detail;
  try {
    const res = await aws.ecr().send(new DescribeImagesCommand({
      repositoryName: repo, registryId: account, imageIds: [{ imageTag: tag }],
    }));
    detail = res.imageDetails && res.imageDetails[0];
  } catch (err) {
    if (err && err.name === 'ImageNotFoundException') return null;
    if (err && err.name === 'RepositoryNotFoundException') {
      throw preflight(`ECR repository ${repo} does not exist in account ${account}`,
        { cause: err, detail: 'run `archie preflight` — the deployment name may be wrong (context.js:29-31)' });
    }
    throw err;
  }
  if (!detail) return null;

  const arches = new Set();
  // Why the architecture set may be empty is worth keeping: "no platform block in a single-arch
  // manifest" and "the caller lacks ecr:BatchGetImage" both end up as `arches: []`, and only one of
  // them is benign. assertArm64 treats an empty set as UNPROVEN either way; this records which.
  let archesFrom = 'manifest';
  try {
    const got = await aws.ecr().send(new BatchGetImageCommand({
      repositoryName: repo,
      registryId: account,
      imageIds: [{ imageTag: tag }],
      acceptedMediaTypes: [
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ],
    }));
    const body = got.images && got.images[0] && got.images[0].imageManifest;
    if (body) {
      const parsed = JSON.parse(body);
      for (const m of parsed.manifests || []) {
        if (m.platform && m.platform.architecture && m.platform.architecture !== 'unknown') arches.add(m.platform.architecture);
      }
    }
  } catch (e) {
    // Best-effort: EXISTENCE is the hard gate above. Not silent, though — the reason rides on the
    // result so `-v` can say why the arch check said nothing.
    archesFrom = `unavailable: ${(e && e.name) || e}`;
  }
  return {
    tag,
    digest: detail.imageDigest,
    pushedAt: detail.imagePushedAt ? new Date(detail.imagePushedAt).toISOString() : null,
    sizeMb: detail.imageSizeInBytes ? Number((detail.imageSizeInBytes / 1048576).toFixed(0)) : null,
    arches: [...arches].sort(),
    archesFrom,
  };
}

/** Refuse an image that is provably not arm64. An UNPROVEN arch is allowed through — see above. */
function assertArm64(found, uri) {
  if (found.arches.length && !found.arches.includes('arm64')) {
    throw refused(`${uri} is ${found.arches.join('/')} — AgentCore microVMs are arm64`,
      { detail: 'this is almost always the amd64 dispatcher image published by mistake' });
  }
}

module.exports = { describeImage, assertArm64 };
