import { InMemoryObjectBucket } from '../src/commerce/object-replica';
import { describeObjectBucketContract } from '../src/commerce/object-replica-contract';

describeObjectBucketContract('in memory', async () => new InMemoryObjectBucket());
