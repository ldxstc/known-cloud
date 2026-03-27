# Known Cloud

Cloudflare Workers API for Known Cloud, backed by Turso and OpenAI.

## SDK

```javascript
import { Known } from '@known/sdk';

const known = new Known({ apiKey: 'kn_live_xxx' });
const context = await known.understand("What should I know?");
```
