import { describeSealedSecretsContract, InMemorySealedSecrets } from '../src/commerce';

describeSealedSecretsContract('in memory', async (fixture) => new InMemorySealedSecrets(fixture));
