// CommerceWorker docs: Starlight over MDX in src/content/. Static output, deployed as a Workers
// static-assets site (wrangler.jsonc). One site for commerce and content management. Reference pages
// render from @commerceworker/core, @commerceworker/domain and both APIs' OpenAPI documents at build
// time, so node catalogs, policy rules, scopes, event names and endpoints can't drift from the code.
import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';

export default defineConfig({
  site: 'https://docs.commerceworker.com',
  // No image transforms: the default service needs `sharp`, a native dependency these docs
  // don't otherwise need.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'CommerceWorker',
      logo: {
        light: './src/assets/mark-light.svg',
        dark: './src/assets/mark-dark.svg',
        alt: '',
      },
      description:
        'CommerceWorker: API-first, agent-first commerce and content on Cloudflare. Guides for the people who run orders, catalog and content, and reference for the systems that integrate with them.',
      // Prose lives at src/content/ (see content.config.ts). Without this Starlight skips its
      // Markdown transforms (asides, heading anchors) for files outside src/content/docs/.
      markdown: { processedDirs: ['./src/content'] },
      // Code blocks on the app's card ground with its hairline and corners. GitHub's themes keep
      // syntax colour quiet next to Ledger's ink; Night Owl (Starlight's default) did not.
      expressiveCode: {
        themes: ['github-light', 'github-dark-dimmed'],
        defaultProps: { frame: 'code' },
        styleOverrides: {
          borderColor: 'var(--ol-rule)',
          borderRadius: 'var(--ol-radius)',
          codeBackground: 'var(--ol-card)',
          codeFontFamily: 'var(--sl-font-mono)',
          codeFontSize: '0.8125rem',
          uiFontFamily: 'var(--sl-font)',
          frames: {
            editorBackground: 'var(--ol-card)',
            editorActiveTabBackground: 'var(--ol-card)',
            editorTabBarBackground: 'var(--ol-muted)',
            editorTabBarBorderBottomColor: 'var(--ol-rule)',
            frameBoxShadowCssValue: 'none',
            inlineButtonBorder: 'var(--ol-rule)',
          },
        },
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/blakebauman/commerceworker' },
      ],
      components: {
        // The web app's theme rule: light by default, then Dark or Match system.
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        // The app's page header: the title, muted description under it.
        PageTitle: './src/components/PageTitle.astro',
        // The app's top-bar links: API explorer, then "Open the app" as the one ink button.
        SocialIcons: './src/components/SocialIcons.astro',
      },
      // The app's faces, self-hosted (the docs fetch no font from a third party), then Ledger:
      // theme.css is generated from @commerceworker/design (`pnpm sync:theme`); brand.css is hand-written.
      customCss: [
        '@fontsource-variable/inter/wght.css',
        '@fontsource/ibm-plex-mono/400.css',
        '@fontsource/ibm-plex-mono/500.css',
        './src/styles/theme.css',
        './src/styles/brand.css',
        // The content reference components' own styles (src/components/content/).
        './src/styles/content.css',
      ],
      // Table-of-contents entries for the generated content reference pages (src/route-data.ts).
      routeMiddleware: './src/route-data.ts',
      head: [{ tag: 'link', attrs: { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' } }],
      // Explicit sidebar: autogenerate expects src/content/docs/. A new page is invisible until
      // it is listed here. Start reads as a sequence (Starlight's prev/next follows this order).
      // The site is for people who use a workspace and developers who integrate with one;
      // deployment, configuration and internals live in the repo's docs/ folder, unpublished.
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Getting started', slug: 'start/getting-started' },
            { label: 'Concepts', slug: 'start/concepts' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Building flows', slug: 'guides/building-flows' },
            { label: 'Commerce models', slug: 'guides/commerce-models' },
            { label: 'Fulfillment', slug: 'guides/fulfillment' },
            { label: 'Built-in flows', slug: 'guides/templates' },
            { label: 'Marketplace', slug: 'guides/marketplace' },
            { label: 'Product catalog', slug: 'guides/product-catalog' },
            { label: 'Payments', slug: 'guides/payments' },
            { label: 'Price books', slug: 'guides/price-books' },
            { label: 'Promotions', slug: 'guides/promotions' },
            { label: 'Companies', slug: 'guides/companies' },
            { label: 'Purchase orders', slug: 'guides/purchase-orders' },
            { label: 'Quotes', slug: 'guides/quotes' },
            { label: 'Approvals and events', slug: 'guides/approvals-and-events' },
            { label: 'Carts', slug: 'guides/carts' },
            { label: 'Punchout', slug: 'guides/punchout' },
            { label: 'Inbound orders', slug: 'guides/inbound-orders' },
            { label: 'Channel adapters', slug: 'guides/channel-adapters' },
            { label: 'Email intake', slug: 'guides/email-intake' },
            { label: 'Outbound webhooks', slug: 'guides/outbound-webhooks' },
            { label: 'AI nodes and the assistant', slug: 'guides/ai' },
            { label: 'The assistant', slug: 'guides/assistant' },
            { label: 'Installing a plugin', slug: 'guides/installing-plugins' },
            { label: 'Team and roles', slug: 'guides/team-and-roles' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'REST API', slug: 'reference/rest-api' },
            { label: 'Node catalog', slug: 'reference/nodes' },
            { label: 'Expressions and policy rules', slug: 'reference/expressions' },
            { label: 'Status lifecycles', slug: 'reference/lifecycles' },
            { label: 'MCP server', slug: 'reference/mcp' },
            { label: 'A2A endpoint', slug: 'reference/a2a' },
            { label: 'Agentic checkout (UCP)', slug: 'reference/ucp' },
            // Scalar over the OpenAPI document generated from apps/web (src/pages/api.astro).
            { label: 'OpenAPI explorer', link: '/api/' },
          ],
        },
        {
          // Content management: model, write, review and ship content, and deliver it anywhere.
          label: 'Content management',
          items: [
            { label: 'Overview', slug: 'content' },
            {
              label: 'Start',
              items: [
                { label: 'Getting started', slug: 'content/start/getting-started' },
                { label: 'Concepts', slug: 'content/start/concepts' },
              ],
            },
            {
              label: 'Content',
              items: [
                { label: 'Content modeling', slug: 'content/guides/content-modeling' },
                { label: 'Editing and publishing', slug: 'content/guides/editing-and-publishing' },
                { label: 'Saved views', slug: 'content/guides/saved-views' },
                {
                  label: 'Releases and scheduling',
                  slug: 'content/guides/releases-and-scheduling',
                },
                { label: 'Workflows', slug: 'content/guides/workflows' },
                { label: 'Approvals and reviews', slug: 'content/guides/approvals' },
              ],
            },
            {
              label: 'Media',
              items: [
                { label: 'Media and assets', slug: 'content/guides/media' },
                { label: 'Share assets with a link', slug: 'content/guides/share-links' },
              ],
            },
            {
              label: 'Site features',
              items: [
                { label: 'Redirects', slug: 'content/guides/redirects' },
                { label: 'SEO and sitemaps', slug: 'content/guides/seo' },
                { label: 'Navigation menus', slug: 'content/guides/menus' },
              ],
            },
            {
              label: 'AI',
              items: [
                { label: 'AI features', slug: 'content/guides/ai' },
                { label: 'Coworker', slug: 'content/guides/coworker' },
              ],
            },
            {
              label: 'Workspace',
              items: [
                { label: 'Team and roles', slug: 'content/guides/team-and-roles' },
                { label: 'Environments', slug: 'content/guides/environments' },
              ],
            },
            {
              label: 'Integrating',
              items: [
                { label: 'API keys and access', slug: 'content/guides/api-keys' },
                { label: 'Build your own frontend', slug: 'content/guides/your-own-frontend' },
                { label: 'Reading content', slug: 'content/guides/reading-content' },
                { label: 'Delivering assets', slug: 'content/guides/delivering-assets' },
                { label: 'Webhooks', slug: 'content/guides/webhooks' },
                { label: 'Functions, plugins and extensions', slug: 'content/guides/extending' },
              ],
            },
            {
              label: 'Developer tools',
              items: [
                { label: 'SDKs', slug: 'content/guides/sdks' },
                { label: 'MCP server', slug: 'content/guides/mcp' },
                { label: 'Command-line tool', slug: 'content/guides/cli' },
                { label: 'Agent skills', slug: 'content/guides/agent-skills' },
              ],
            },
            {
              label: 'Reference',
              items: [
                { label: 'REST API', slug: 'content/reference/rest-api' },
                { label: 'Field types', slug: 'content/reference/field-types' },
                { label: 'Node catalog', slug: 'content/reference/nodes' },
                { label: 'Workflow templates', slug: 'content/reference/workflow-templates' },
                { label: 'Permission scopes', slug: 'content/reference/scopes' },
                // Scalar over the content API's OpenAPI document (src/pages/content/api.astro).
                { label: 'OpenAPI explorer', link: '/content/api/' },
              ],
            },
          ],
        },
      ],
    }),
  ],
});
