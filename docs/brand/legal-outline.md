# Legal page outlines

Outlines for the privacy policy and terms of service on commerceworker.com, carried over from v1's marketing site. They are prompts for counsel, not legal text: each section says what the final page must state. The marketing site publishes neither page until counsel supplies the text (ROADMAP, P9).

## Privacy policy

### Introduction

This policy describes how the operator of the CommerceWorker platform and related marketing sites (referred to as "we", "us", or "the operator") handles personal information. Replace this introduction with your legal entity name, registered address, and the scope of services (the marketing site, the docs, and each customer's isolated deployment with its admin, APIs and storefront-facing endpoints). State whether you act as a controller, processor, or both for different categories of data.


### Who is responsible

Identify the data controller(s) and, where applicable, processors. If merchants using your platform process their customers' data, clarify the controller/processor split (you vs merchant) and point to merchant obligations or data processing agreements.


### What we collect

Typical categories to enumerate with your actual practices:

- Account and profile data (name, email, company, billing contacts)
- Transactional and device data (orders, IP address, approximate location, user agent)
- Support and communications (tickets, chat logs, email content)
- Analytics and product telemetry you enable (cookies, events, error reports)
- Information merchants upload about their buyers (often controlled by the merchant)

### How and why we use data

Map each purpose to a lawful basis where GDPR or similar law applies: contract, legitimate interests, consent, legal obligation. Examples: provide the service, bill, secure the platform, comply with law, improve reliability, send service messages vs marketing (with opt-out where required).


### Cookies and similar technologies

List essential vs optional cookies, retention, and how to manage preferences. Link a cookie notice or settings UI if you operate one.


### Sharing and subprocessors

Name categories of recipients (hosting, email, analytics, payments) and major vendors (Cloudflare, Stripe, etc.) with links to their policies. Maintain a current subprocessor list for enterprise customers.


### International transfers

If data moves across borders, describe mechanisms (SCCs, adequacy decisions, or other valid transfer tools) in the form your counsel recommends.


### Retention

State how long categories are kept and criteria for deletion or anonymization, including backups and legal holds.


### Security

Summarize technical and organizational measures at a high level. Avoid absolute promises you cannot keep (“100% secure”).


### Your rights

Describe how individuals can access, correct, delete, export, or object — and any region-specific rights (GDPR, CCPA/CPRA, etc.). Provide a contact or self-service path and appeal process if applicable.


### Children

State that the service is not directed at children under a defined age and how you handle inadvertent collection, consistent with applicable law.


### Changes

Explain how you notify users of material changes (email, in-product banner, revised date at the top of this page) and when changes take effect.


### Contact

Replace with real contact details: privacy email, postal address, and if required Data Protection Officer or EU representative information.

{legalContactEmail() || (import.meta.env.DEV ? 'legal@localhost' : '— set VITE_LEGAL_CONTACT_EMAIL for production')}


## Terms of service

### Agreement

Identify the legal agreement: who “we” are (entity), who “you” are (customer, merchant, visitor), and that using the site or service constitutes acceptance of these terms and incorporated policies (privacy, DPA, SLA, acceptable use).


### Services

Describe what CommerceWorker provides as SaaS: availability expectations, support tiers, beta or preview features, and that you may change non-material aspects with reasonable notice.


### Accounts and eligibility

Age and authority requirements, accurate registration information, credential security, responsibility for activity under the account, and notification of compromise.


### Acceptable use

Prohibit illegal content, abuse of APIs, credential stuffing, attempting to bypass limits, mining personal data without basis, interference with the platform, and other misuse. Reserve suspension or termination for violations.


### Customer data and merchants

If tenants run stores for end customers, clarify ownership of merchant data, your role as processor vs controller where applicable, and that merchants must post their own policies and comply with laws (PCI scope, marketing consent, etc.).


### Fees, taxes, and trials

Billing cadence, taxes, late payment, credits, trials, refunds, and how price changes apply. Reference Stripe or your billing provider where relevant.


### Intellectual property

Your IP in the platform, customer IP in content they upload, and license grants needed to operate the service (e.g. limited license to host store data, use marks in dashboards as agreed).


### Third-party services

Payment processors, carriers, tax engines, and extensions are third parties; their terms govern those relationships. You are not responsible for third-party failures beyond what your SLA states.


### Confidentiality

Mutual confidentiality obligations, exceptions (public, independently developed, legal requirement), and survival on termination.


### Warranty disclaimer

Use counsel-approved capitalized disclaimer language where appropriate (e.g. services “as is” / “as available”, no implied warranties to the fullest extent permitted).


### Limitation of liability

Cap types of damages, aggregate liability limits tied to fees paid in a period, and carve-outs for liability that cannot be limited by law.


### Indemnity

Customer indemnity for misuse, content they supply, violation of law, and third-party claims arising from their storefronts — bounded as your counsel advises.


### Term and termination

Subscription term, renewal, notice for convenience where allowed, termination for breach, effect on data export and deletion, and survival of accrued obligations.


### Governing law and disputes

Choose governing law and venue or arbitration (including any consumer carve-outs). Ensure alignment with where you sell and with Stripe or marketplace rules if applicable.


### General

Assignment, force majeure, notices (email and address), entire agreement, severability, no waiver, and order of precedence between agreements.


### Contact

Legal and operational contacts for notices: email and postal address for [your legal entity name].

{legalContactEmail() || (import.meta.env.DEV ? 'legal@localhost' : '— set VITE_LEGAL_CONTACT_EMAIL for production')}

