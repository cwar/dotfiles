-- epub-preview.yazi - Enhanced epub preview with cover + metadata
local M = {}
local suffix = "_epubmeta"

local function read_cached_file(file_path)
	local file = io.open(file_path, "r")
	if file then
		local content = file:read("*all")
		file:close()
		return content
	end
end

local function extract_metadata(epub_path, cache_path)
	-- Try ebook-meta first (from calibre)
	local output, err = Command("ebook-meta"):arg(tostring(epub_path)):output()
	if output and output.stdout and output.stdout ~= "" then
		return fs.write(Url(cache_path), output.stdout)
	end

	-- Fallback: extract from OPF using unzip
	local unzip_out, unzip_err = Command("unzip")
		:arg("-p")
		:arg(tostring(epub_path))
		:arg("*.opf")
		:output()

	if not unzip_out or not unzip_out.stdout then
		return fs.write(Url(cache_path), "Unable to read epub metadata")
	end

	local xml = unzip_out.stdout
	local metadata = {}

	-- Parse common metadata fields
	local title = xml:match("<dc:title[^>]*>([^<]+)</dc:title>")
	local creator = xml:match("<dc:creator[^>]*>([^<]+)</dc:creator>")
	local publisher = xml:match("<dc:publisher[^>]*>([^<]+)</dc:publisher>")
	local date = xml:match("<dc:date[^>]*>([^<]+)</dc:date>")
	local language = xml:match("<dc:language[^>]*>([^<]+)</dc:language>")
	local description = xml:match("<dc:description[^>]*>([^<]+)</dc:description>")

	local lines = {}
	if title then table.insert(lines, "Title: " .. title) end
	if creator then table.insert(lines, "Author: " .. creator) end
	if publisher then table.insert(lines, "Publisher: " .. publisher) end
	if date then table.insert(lines, "Date: " .. date) end
	if language then table.insert(lines, "Language: " .. language) end
	if description then
		-- Clean up HTML entities and truncate
		description = description:gsub("&#13;", " "):gsub("&amp;", "&"):gsub("&lt;", "<"):gsub("&gt;", ">")
		description = description:gsub("%s+", " "):sub(1, 500)
		table.insert(lines, "")
		table.insert(lines, "Description:")
		table.insert(lines, description)
	end

	return fs.write(Url(cache_path), table.concat(lines, "\n"))
end

local function extract_cover(epub_path, cache_path)
	-- Try epub-thumbnailer first
	local child = Command("epub-thumbnailer")
		:arg(tostring(epub_path))
		:arg(tostring(cache_path))
		:arg("512")
		:spawn()

	if child then
		local status = child:wait()
		if status and status.success then
			return true
		end
	end

	-- Fallback to gnome-epub-thumbnailer
	child = Command("gnome-epub-thumbnailer")
		:arg(tostring(epub_path))
		:arg(tostring(cache_path))
		:spawn()

	if child then
		local status = child:wait()
		return status and status.success
	end

	return false
end

function M:peek(job)
	local cache = ya.file_cache(job)
	if not cache then
		return
	end

	local cache_meta_path = tostring(cache) .. suffix

	-- Preload cover and metadata
	self:preload(job)

	local has_cover = fs.cha(cache)
	local lines = {}
	local limit = job.area.h
	local is_wrap = rt.preview.wrap == "yes"

	-- Read metadata
	local metadata = read_cached_file(cache_meta_path)
	if metadata then
		for line in metadata:gmatch("[^\n]+") do
			if #lines < limit then
				-- ebook-meta format: "Label           : Value" (spaces before colon)
				local label, value = line:match("^(.-)%s*:%s*(.+)$")
				if label and label ~= "" then
					-- Trim the label
					label = label:match("^%s*(.-)%s*$")
					table.insert(lines, ui.Line({
						ui.Span(label .. ": "):style(ui.Style():fg("reset"):bold()),
						ui.Span(value):style(ui.Style():fg("blue")),
					}))
				else
					-- Continuation line (e.g., multi-line comments) - use dim style
					table.insert(lines, ui.Line({ ui.Span(line):style(ui.Style():fg("blue")) }))
				end
			end
		end
	end

	local metadata_height = #lines
	local image_height = 0

	-- Show cover image if available
	if has_cover then
		local img_area_height = metadata_height > 0
			and math.max(job.area.h - metadata_height - 1, math.floor(job.area.h / 2))
			or job.area.h

		local rendered = ya.image_show(cache, ui.Rect({
			x = job.area.x,
			y = job.area.y,
			w = job.area.w,
			h = img_area_height,
		}))

		if rendered then
			image_height = rendered.h
		end
	end

	-- Show metadata below image
	if #lines > 0 then
		ya.preview_widget(job, {
			ui.Text(lines)
				:area(ui.Rect({
					x = job.area.x,
					y = job.area.y + image_height,
					w = job.area.w,
					h = job.area.h - image_height,
				}))
				:wrap(is_wrap and ui.Wrap.YES or ui.Wrap.NO),
		})
	else
		ya.preview_widget(job, {})
	end
end

function M:seek(job)
	-- No seeking for epub
end

function M:preload(job)
	local cache = ya.file_cache(job)
	if not cache then
		return 1
	end

	local cache_meta_path = tostring(cache) .. suffix
	local epub_path = job.file.url

	-- Extract cover if not cached
	if not fs.cha(cache) then
		extract_cover(epub_path, cache)
	end

	-- Extract metadata if not cached
	if not fs.cha(Url(cache_meta_path)) then
		extract_metadata(epub_path, cache_meta_path)
	end

	return 1
end

return M
