insert into categories (name)
values ('AI'), ('Browsing'), ('Personal'), ('Design'), ('System'), ('Productivity')
on conflict (name) do nothing;

insert into category_rules (category_id, app_pattern, host_pattern, priority)
select c.id, r.app_pattern, r.host_pattern, -10
from (values
    ('AI', '^(ChatGPT|Claude)$'::text, null::text),
    ('AI', null, '(^|\.)(chatgpt\.com|claude\.ai|perplexity\.ai|gemini\.google\.com|kimi\.ai|openrouter\.ai)$'),
    ('Browsing', '^(Brave Browser.*|Google Chrome.*|Safari|Firefox|Microsoft Edge|Arc)$', null),
    ('Browsing', null, '^(www\.google\.com|search\.brave\.com|www\.bing\.com|duckduckgo\.com)$'),
    ('Personal', null, '(^|\.)(amazon\.(de|com)|gotogate\.com|studentoffers\.co|maat\.pt|britishmuseum\.org|stepstone\.de|apple\.com)$|^(gallery|immich)\.aquitano\.me$'),
    ('Design', '^(Affinity.*|Nik 9 .*)$', null),
    ('System', '^(Finder|System Settings|loginwindow|SecurityAgent|UserNotificationCenter|Thaw|Cloudflare WARP|Proton VPN|rcmd|Activity Monitor)$', null),
    ('Productivity', '^(TextEdit|Wispr Flow)$', null),
    ('Productivity', null, '^form\.typeform\.com$'),
    ('Focus/Code', '^(Docker Desktop|Executor)$', null),
    ('Focus/Code', null, '(^|\.)(cloudflare\.com|vercel\.com|infisical\.com|codeburn\.app)$|^(aqt-web\.vercel\.app|codeburn\.aquitano\.me|aquitano\.github\.io)$'),
    ('Communication', '^[‎‏]*WhatsApp$', null),
    ('Communication', null, '^(mail\.proton\.me|www\.linkedin\.com)$'),
    ('Learning', null, '(^|\.)(overleaf\.com|uni-passau\.de|effect\.website)$'),
    ('Distraction', '^(NewLifeGame|Minecraft Launcher|QuickTime Player)$', null),
    ('Distraction', null, '(^|\.)(disneyplus\.com|crunchyroll\.com|justwatch\.com|xbox\.com|instant-gaming\.com)$')
) as r(category, app_pattern, host_pattern)
join categories c on c.name = r.category;
