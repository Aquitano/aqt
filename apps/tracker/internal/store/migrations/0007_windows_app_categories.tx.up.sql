-- The Windows agent names an app by its exe's FileDescription, which the
-- macOS seeds do not cover: Visual Studio Code is not Code, and explorer.exe
-- is Windows Explorer. Same low priority as the 0004 seeds, so a rule edited
-- or added since wins.
insert into category_rules (category_id, app_pattern, host_pattern, priority)
select c.id, r.app_pattern, null, -10
from (values
    ('Focus/Code', '^(Visual Studio Code|Visual Studio .*|Windows Terminal|Windows PowerShell|PowerShell.*|pwsh|Windows Command Processor|Console Window Host|(JetBrains )?(IntelliJ IDEA|GoLand|WebStorm|PyCharm|Rider|CLion|RustRover)( .*)?)$'::text),
    ('Communication', '^(Microsoft Outlook|Microsoft Teams.*)$'),
    ('Productivity', '^(Microsoft (Word|Excel|PowerPoint|OneNote)|Notepad|Notion|Obsidian)$'),
    ('System', '^(Windows Explorer|File Explorer|Settings|Task Manager|Control Panel|Windows Security|Snipping Tool)$'),
    ('Distraction', '^(Steam)$')
) as r(category, app_pattern)
join categories c on c.name = r.category;
