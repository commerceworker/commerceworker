/** An order as a buyer names it: the last six characters of its id, as the admin shows it (`orderRef`). */
export const orderRef = (id: string) => `#${id.slice(-6)}`;
