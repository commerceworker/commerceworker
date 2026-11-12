/**
 * Data subject requests: the subject use-cases (@commerceworker/application/commerce) bound to
 * this deployment's tables, its R2 bucket and its order and cart agents. Find everything held
 * about one person by their email address, then export it or erase it; erasing works through
 * their orders a batch at a time, and the retention sweep erases expired orders through
 * `eraseOrders`.
 */
import * as uc from '@commerceworker/application/commerce';
import { objectStore, orderRuntime, shopperAuth, subjectCarts, subjectStore } from './wire';

const ports = (env: Env): uc.SubjectPorts => ({
  subjects: subjectStore(env),
  files: objectStore(env),
  orders: orderRuntime(env),
  carts: subjectCarts(env),
  shoppers: shopperAuth(env),
});

export const exportDataSubject = (env: Env, raw: string) =>
  uc.exportDataSubject(ports(env), raw, Date.now());

export const eraseDataSubject = (env: Env, raw: string) =>
  uc.eraseDataSubject(ports(env), raw, Date.now());

/** Erases the buyer from finished orders; one still running is named in `refused`. */
export const eraseOrders = (env: Env, list: { id: string; title: string }[], terms: string[]) =>
  uc.eraseOrders(ports(env), list, terms, Date.now());

/** Erases the buyer from one external cart if they were erased before it was indexed under them. */
export const eraseIfErased = (env: Env, cartId: string, email: string) =>
  uc.eraseIfErased(ports(env), cartId, email);
