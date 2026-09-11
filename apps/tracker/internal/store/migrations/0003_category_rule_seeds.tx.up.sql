-- Seed corrections, applied only where the seed is still in place so an
-- edited rule keeps its edit.
update category_rules
set app_pattern = '^(Code|Cursor|Xcode|IntelliJ IDEA|T3 Code.*|Terminal|iTerm2|Ghostty|Warp|Zed|Instruments|Simulator)$'
where app_pattern = '^(Code|Cursor|Xcode|Terminal|iTerm2|Ghostty|Warp|Zed|Instruments|Simulator)$';

update category_rules
set host_pattern = '^(github\.com|localhost|127\.0\.0\.1)$'
where host_pattern = '^(github\.com|localhost)$';

update category_rules
set host_pattern = '(^|\.)(youtube\.com|x\.com|twitter\.com|reddit\.com|instagram\.com|tiktok\.com|facebook\.com|news\.ycombinator\.com|netflix\.com)$'
where host_pattern = '(^|\.)(youtube\.com|x\.com|twitter\.com|reddit\.com|instagram\.com|tiktok\.com|facebook\.com|news\.ycombinator\.com)$';
