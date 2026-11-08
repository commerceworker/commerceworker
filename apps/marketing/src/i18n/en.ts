/**
 * The marketing site's English copy. Voice and claims follow docs/brand/messaging.md: calm, exact,
 * one idea per sentence, and nothing the product doesn't do today. es.ts holds the same keys
 * (src/i18n/copy.test.ts fails on a missing or empty one).
 */
export const en = {
  lang: 'en',
  nav: {
    features: 'Features',
    docs: 'Docs',
    signIn: 'Sign in',
    language: 'Español',
    skip: 'Skip to content',
  },
  footer: {
    tagline: 'API-first, agent-first commerce on Cloudflare.',
    product: 'Product',
    developers: 'Developers',
    docs: 'Documentation',
    restApi: 'REST API',
    mcp: 'MCP server',
    contentDocs: 'Content management',
  },
  home: {
    metaTitle: 'CommerceWorker: commerce that runs as code',
    metaDescription:
      'API-first, agent-first commerce on Cloudflare. Every order runs as a durable workflow you can see, and every capability is reachable by people and agents through the same API.',
    heroTitle: 'Commerce that runs as code.',
    heroLead:
      'CommerceWorker is API-first commerce infrastructure on Cloudflare. Each customer gets an isolated deployment, and people and agents reach every capability through the same interface.',
    ctaStart: 'Get started',
    ctaSignIn: 'Sign in',
    loopTitle: 'Every order is an Order Loop.',
    loopBody:
      'An Order Loop is a durable workflow drawn as a graph. Each step shows its live state, the approvals it waits for, and its history. Every channel and order model runs the same way: storefront, marketplace, subscription and purchase order.',
    loopSteps: ['Intake', 'Price', 'Approve', 'Reserve', 'Authorize', 'Ship'],
    loopFoot: 'A failed step rolls back what the loop did, in reverse order, to a known state.',
    apiTitle: 'REST and MCP. Same orders, same rules.',
    apiBody:
      'Your storefront calls the REST API. An agent calls the MCP server. Both read the same order, decide the same approvals and are held to the same role.',
    apiRest: 'REST',
    apiMcp: 'MCP',
    apiFoot:
      'Agentic checkout speaks UCP, and other agents follow orders over A2A. ACP is planned.',
    b2bTitle: 'Built for how B2B buys.',
    b2bBody:
      'Purchase orders arrive by email, punchout or EDI 850 and run through the same loop as a web order.',
    b2bSteps: [
      { title: 'Request', body: 'A purchase order arrives by email, punchout or EDI 850.' },
      { title: 'Check', body: 'Policy, credit and budget checks run on the order.' },
      { title: 'Approve', body: 'Over the limit, it waits for the approver, with a timeout.' },
      { title: 'Order', body: 'Approved, it reserves stock and issues the invoice.' },
    ],
    contentTitle: 'Content in the same place.',
    contentBody:
      'Model content once and deliver it anywhere: product stories, landing pages and help articles over REST, GraphQL and SDKs. Editors write, review and publish in the studio. Assets come from the assets service or your own DAM.',
    deployTitle: 'Your deployment. No shared tenancy.',
    deployBody:
      'Each customer runs in an isolated deployment on Cloudflare: its own D1 databases, storage, queues, Durable Objects and Workflows. Nothing is pooled with another customer.',
    closeTitle: 'Read the reference, then place an order.',
    closeBody: 'The storefront is yours to build. CommerceWorker is the engine behind it.',
    closeCta: 'Read the docs',
  },
  features: {
    metaTitle: 'Features: CommerceWorker',
    metaDescription:
      'Order Loops, agent surfaces, B2B intake, catalog and checkout, content management and isolated deployments on Cloudflare.',
    title: 'Features',
    intro:
      'What CommerceWorker does today. Each section links to the documentation that covers it.',
    more: 'Read more',
    sections: [
      {
        heading: 'Order Loops',
        doc: '/guides/building-flows/',
        items: [
          {
            title: 'Flows you draw',
            body: 'Pricing, payments, approvals, shipping, pickup, digital delivery and marketplace sellers are nodes in a graph. Publishing a flow creates an immutable version; each order pins the one it started on.',
          },
          {
            title: 'Durable by default',
            body: 'Each order runs on Cloudflare Workflows. Steps retry, waits survive restarts, and long subscriptions continue as a new run without growing their history.',
          },
          {
            title: 'Rollback',
            body: 'Reserving stock, authorizing payment and creating a shipment register a compensation. A failed loop undoes them in reverse order.',
          },
        ],
      },
      {
        heading: 'Agent surfaces',
        doc: '/reference/mcp/',
        items: [
          {
            title: 'MCP server',
            body: 'Agents find orders, read them and decide approvals with the same roles as people. Actions that change an order ask for confirmation.',
          },
          {
            title: 'Agentic checkout (UCP)',
            body: 'AI shopping platforms check out against the same pricing the order flow uses, and pay through Stripe.',
          },
          {
            title: 'A2A',
            body: 'Other agents place and follow orders as A2A tasks.',
          },
        ],
      },
      {
        heading: 'B2B and channels',
        doc: '/guides/inbound-orders/',
        items: [
          {
            title: 'Every channel, one loop',
            body: 'Signed webhooks from a storefront, marketplace or POS, Shopify orders, EDI X12 850 purchase orders and order email all start the same kind of order.',
          },
          {
            title: 'Procurement',
            body: 'Punchout carts from buyers’ procurement systems, credit and budget checks, approvals with timeouts and escalation, and generated purchase orders.',
          },
        ],
      },
      {
        heading: 'Catalog, pricing and checkout',
        doc: '/guides/product-catalog/',
        items: [
          {
            title: 'Sharded product catalog',
            body: 'Products are stored across Durable Object shards and published to a cached read edge.',
          },
          {
            title: 'Pricing and promotions',
            body: 'Price books, contract prices and volume tiers run in priority order, and each line takes the lowest price that applies, or the list price. Promotion codes carry total and per-customer redemption limits.',
          },
          {
            title: 'Carts and payments',
            body: 'Shared carts, Stripe authorization, capture, refunds and invoices, each keyed by its step so a retry never charges twice.',
          },
        ],
      },
      {
        heading: 'Content management',
        doc: '/content/',
        items: [
          {
            title: 'Structured content',
            body: 'Typed fields with validation, localization and references. Rich text is a typed document, not HTML.',
          },
          {
            title: 'Releases and workflows',
            body: 'Every save is a version. Releases publish many changes together; workflows route content through review.',
          },
          {
            title: 'Delivery',
            body: 'Read published content over REST, GraphQL and SDKs, served from the edge cache.',
          },
        ],
      },
      {
        heading: 'Deployment and operations',
        doc: '/start/concepts/',
        items: [
          {
            title: 'One stack per customer',
            body: 'Each deployment has its own Workers, D1 databases, storage, queues and secrets, deployed ring by ring from CI.',
          },
          {
            title: 'Cloudflare primitives',
            body: 'D1, Durable Objects, Workflows, Queues, R2, KV, Workers AI and Email Routing. No database outside Cloudflare.',
          },
          {
            title: 'Audit log',
            body: 'Security and business events are recorded in a hash-chained log you can verify.',
          },
        ],
      },
    ],
  },
  notFound: {
    metaTitle: 'Page not found: CommerceWorker',
    title: 'No page at this address.',
    body: 'The page may have moved. The home page and the documentation link to everything on this site.',
    home: 'Go to the home page',
  },
};

export type Copy = typeof en;
