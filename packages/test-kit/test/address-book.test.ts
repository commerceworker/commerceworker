import { describeAddressBookContract, InMemoryAddressBook } from '../src/commerce';

describeAddressBookContract('in memory', async (fixture) => new InMemoryAddressBook(fixture));
