# Browser provider readiness

| Provider | Browser identity | Reads | Writes | Evidence and owner action |
| --- | --- | --- | --- | --- |
| Registered website | FIXTURE_VERIFIED | FIXTURE_VERIFIED for declared scopes | UNSUPPORTED | Register a permitted site and authenticate if required. Live readiness depends on that source. |
| LinkedIn | UNVERIFIED | MANUAL_ONLY by default | UNSUPPORTED | Legacy Jobs and feed tool names remain. A configured dedicated CDP reader requires documented LinkedIn permission. [LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions) |
| Instagram | UNVERIFIED | MANUAL_ONLY | UNSUPPORTED | Owner export is an option. [Meta](https://about.fb.com/news/2020/11/combating-clone-sites/) |
| Facebook | UNVERIFIED | MANUAL_ONLY | UNSUPPORTED | Automated collection requires Meta's permission. [Meta](https://about.fb.com/news/2021/04/how-we-combat-scraping/) |
| Threads | UNVERIFIED | MANUAL_ONLY | UNSUPPORTED | No verified Threads browser adapter or permission specific to its UI. [Meta collection policy overview](https://about.fb.com/news/2021/04/how-we-combat-scraping/) |
| TikTok | UNVERIFIED | MANUAL_ONLY | UNSUPPORTED | Consumer UI permission and verification pending. Documented developer terms cover developer services. [TikTok](https://t.tiktok.com/legal/page/global/tik-tok-developer-terms-of-service/en) |
| X | UNVERIFIED | MANUAL_ONLY | UNSUPPORTED | X restricts scraping and non-API automation. [X terms](https://x.com/en/tos), [automation rules](https://help.x.com/en/rules-and-policies/x-automation) |
| Reddit | UNVERIFIED | MANUAL_ONLY | UNSUPPORTED | Reddit restricts scraping without prior written consent. Its robots.txt-based crawling grant has narrower scope. [Reddit](https://redditinc.com/policies/user-agreement) |

Fixture verification covers installed Chrome and the approved-source contract. Real platform readiness requires operation-specific permission and an owner-authenticated acceptance run.
