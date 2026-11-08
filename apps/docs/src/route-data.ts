// Table-of-contents entries for the generated reference pages. Starlight builds a page's contents
// from the headings written in its MDX, so the node and template cards (CardHeading.astro, rendered
// by NodeCatalog.astro and WorkflowTemplates.astro) would otherwise be missing from it. The entries
// come from the same domain objects as the cards, so the two can't disagree.

import { defineRouteMiddleware, type StarlightRouteData } from '@astrojs/starlight/route-data';
import { NODE_SPECS, type NodeCategory, WORKFLOW_TEMPLATES } from '@commerceworker/domain';

// The nodes page's h2 for each category (src/content/content/reference/nodes.mdx).
const CATEGORY_SECTIONS: Record<NodeCategory, string> = {
  trigger: 'triggers',
  content: 'content',
  control: 'control',
  ai: 'ai',
};

export const onRequest = defineRouteMiddleware((context) => {
  // Starlight declares `starlightRoute` on Locals in a global file this project's tsc doesn't load.
  const route = (context.locals as { starlightRoute: StarlightRouteData }).starlightRoute;
  const toc = route.toc;
  if (!toc) return;

  if (route.id === 'content/reference/nodes') {
    for (const section of toc.items) {
      const specs = NODE_SPECS.filter((s) => CATEGORY_SECTIONS[s.category] === section.slug);
      section.children = specs.map((s) => ({
        depth: 3,
        slug: s.type,
        text: s.label,
        children: [],
      }));
    }
  }

  if (route.id === 'content/reference/workflow-templates') {
    for (const template of Object.values(WORKFLOW_TEMPLATES)) {
      const w = template();
      toc.items.push({ depth: 2, slug: w.id, text: w.name, children: [] });
    }
  }
});
