import type { Copy } from './en';

/** The marketing site's Spanish copy: the same keys as en.ts, the same claims. */
export const es: Copy = {
  lang: 'es',
  nav: {
    features: 'Funciones',
    docs: 'Documentación',
    signIn: 'Iniciar sesión',
    language: 'English',
    skip: 'Ir al contenido',
  },
  footer: {
    tagline: 'Comercio API-first y para agentes, sobre Cloudflare.',
    product: 'Producto',
    developers: 'Desarrolladores',
    docs: 'Documentación',
    restApi: 'API REST',
    mcp: 'Servidor MCP',
    contentDocs: 'Gestión de contenido',
  },
  home: {
    metaTitle: 'CommerceWorker: comercio que funciona como código',
    metaDescription:
      'Comercio API-first y para agentes, sobre Cloudflare. Cada pedido se ejecuta como un flujo duradero que puedes ver, y personas y agentes acceden a cada función con la misma API.',
    heroTitle: 'Comercio que funciona como código.',
    heroLead:
      'CommerceWorker es infraestructura de comercio API-first sobre Cloudflare. Cada cliente tiene un despliegue aislado, y personas y agentes acceden a cada función con la misma interfaz.',
    ctaStart: 'Empezar',
    ctaSignIn: 'Iniciar sesión',
    loopTitle: 'Cada pedido es un Order Flow.',
    loopBody:
      'Un Order Flow es un flujo duradero dibujado como un grafo. Cada paso muestra su estado en vivo, las aprobaciones que espera y su historial. Todos los canales y modelos de pedido funcionan igual: tienda, marketplace, suscripción y orden de compra.',
    loopSteps: ['Entrada', 'Precio', 'Aprobación', 'Reserva', 'Autorización', 'Envío'],
    loopFoot:
      'Si un paso falla, el flujo deshace lo que hizo, en orden inverso, hasta un estado conocido.',
    apiTitle: 'REST y MCP. Los mismos pedidos, las mismas reglas.',
    apiBody:
      'Tu tienda llama a la API REST. Un agente llama al servidor MCP. Ambos leen el mismo pedido, deciden las mismas aprobaciones y responden al mismo rol.',
    apiRest: 'REST',
    apiMcp: 'MCP',
    apiFoot:
      'El checkout para agentes habla UCP, y otros agentes siguen los pedidos por A2A. ACP está previsto.',
    b2bTitle: 'Hecho para cómo compra el B2B.',
    b2bBody:
      'Las órdenes de compra llegan por correo, punchout o EDI 850 y recorren el mismo flujo que un pedido web.',
    b2bSteps: [
      { title: 'Solicitud', body: 'Una orden de compra llega por correo, punchout o EDI 850.' },
      {
        title: 'Control',
        body: 'Se comprueban la política, el crédito y el presupuesto del pedido.',
      },
      {
        title: 'Aprobación',
        body: 'Si supera el límite, espera al aprobador, con un plazo.',
      },
      { title: 'Pedido', body: 'Aprobado, reserva el stock y emite la factura.' },
    ],
    contentTitle: 'El contenido, en el mismo lugar.',
    contentBody:
      'Modela el contenido una vez y entrégalo en cualquier parte: historias de producto, páginas de destino y artículos de ayuda por REST, GraphQL y SDK. Los editores escriben, revisan y publican en el studio. Los recursos vienen del servicio de recursos o de tu propio DAM.',
    deployTitle: 'Tu despliegue. Sin tenencia compartida.',
    deployBody:
      'Cada cliente se ejecuta en un despliegue aislado sobre Cloudflare: sus propias bases de datos D1, almacenamiento, colas, Durable Objects y Workflows. Nada se comparte con otro cliente.',
    closeTitle: 'Lee la referencia y luego haz un pedido.',
    closeBody: 'La tienda la construyes tú. CommerceWorker es el motor que la sostiene.',
    closeCta: 'Leer la documentación',
  },
  features: {
    metaTitle: 'Funciones: CommerceWorker',
    metaDescription:
      'Order Flows, interfaces para agentes, entrada B2B, catálogo y checkout, gestión de contenido y despliegues aislados sobre Cloudflare.',
    title: 'Funciones',
    intro:
      'Lo que CommerceWorker hace hoy. Cada sección enlaza con la documentación que la explica (en inglés).',
    more: 'Más información',
    sections: [
      {
        heading: 'Order Flows',
        doc: '/guides/building-flows/',
        items: [
          {
            title: 'Flujos que dibujas',
            body: 'Precios, pagos, aprobaciones, envíos, recogida, entrega digital y vendedores de marketplace son nodos de un grafo. Publicar un flujo crea una versión inmutable; cada pedido fija la versión con la que empezó.',
          },
          {
            title: 'Duradero por defecto',
            body: 'Cada pedido se ejecuta en Cloudflare Workflows. Los pasos se reintentan, las esperas sobreviven a los reinicios y las suscripciones largas continúan en una ejecución nueva sin que crezca su historial.',
          },
          {
            title: 'Reversión',
            body: 'Reservar stock, autorizar un pago y crear un envío registran una compensación. Un flujo que falla las deshace en orden inverso.',
          },
        ],
      },
      {
        heading: 'Interfaces para agentes',
        doc: '/reference/mcp/',
        items: [
          {
            title: 'Servidor MCP',
            body: 'Los agentes buscan pedidos, los leen y deciden aprobaciones con los mismos roles que las personas. Las acciones que cambian un pedido piden confirmación.',
          },
          {
            title: 'Checkout para agentes (UCP)',
            body: 'Las plataformas de compra con IA pagan con los mismos precios que usa el flujo del pedido, a través de Stripe.',
          },
          {
            title: 'A2A',
            body: 'Otros agentes crean y siguen pedidos como tareas A2A.',
          },
        ],
      },
      {
        heading: 'B2B y canales',
        doc: '/guides/inbound-orders/',
        items: [
          {
            title: 'Todos los canales, un flujo',
            body: 'Webhooks firmados de una tienda, marketplace o TPV, pedidos de Shopify, órdenes de compra EDI X12 850 y pedidos por correo inician el mismo tipo de pedido.',
          },
          {
            title: 'Compras',
            body: 'Carritos punchout desde los sistemas de compras del comprador, controles de crédito y presupuesto, aprobaciones con plazos y escalado, y órdenes de compra generadas.',
          },
        ],
      },
      {
        heading: 'Catálogo, precios y checkout',
        doc: '/guides/product-catalog/',
        items: [
          {
            title: 'Catálogo de productos distribuido',
            body: 'Los productos se guardan en fragmentos de Durable Objects y se publican en una capa de lectura con caché.',
          },
          {
            title: 'Precios y promociones',
            body: 'Las listas de precios, los precios de contrato y los tramos por volumen se aplican por prioridad, y cada línea toma el precio más bajo que corresponda, o el precio de lista. Los códigos promocionales tienen límites de canje totales y por cliente.',
          },
          {
            title: 'Carritos y pagos',
            body: 'Carritos compartidos, autorización, cobro, reembolsos y facturas de Stripe, cada uno vinculado a su paso para que un reintento nunca cobre dos veces.',
          },
        ],
      },
      {
        heading: 'Gestión de contenido',
        doc: '/content/',
        items: [
          {
            title: 'Contenido estructurado',
            body: 'Campos tipados con validación, localización y referencias. El texto enriquecido es un documento tipado, no HTML.',
          },
          {
            title: 'Publicaciones y flujos de trabajo',
            body: 'Cada guardado es una versión. Las publicaciones agrupan muchos cambios; los flujos de trabajo llevan el contenido a revisión.',
          },
          {
            title: 'Entrega',
            body: 'Lee el contenido publicado por REST, GraphQL y SDK, servido desde la caché en el borde.',
          },
        ],
      },
      {
        heading: 'Despliegue y operación',
        doc: '/start/concepts/',
        items: [
          {
            title: 'Un stack por cliente',
            body: 'Cada despliegue tiene sus propios Workers, bases de datos D1, almacenamiento, colas y secretos, desplegados por anillos desde CI.',
          },
          {
            title: 'Primitivas de Cloudflare',
            body: 'D1, Durable Objects, Workflows, Queues, R2, KV, Workers AI y Email Routing. Ninguna base de datos fuera de Cloudflare.',
          },
          {
            title: 'Registro de auditoría',
            body: 'Los eventos de seguridad y de negocio se guardan en un registro encadenado por hash que puedes verificar.',
          },
        ],
      },
    ],
  },
  notFound: {
    metaTitle: 'Página no encontrada: CommerceWorker',
    title: 'No hay ninguna página en esta dirección.',
    body: 'Puede que la página se haya movido. La página de inicio y la documentación enlazan con todo el sitio.',
    home: 'Ir a la página de inicio',
  },
};
