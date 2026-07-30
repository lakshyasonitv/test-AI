"""Crawl4AI-based page crawler that extracts structured DOM information."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from schemas import (
    AccessibilityInfo,
    Button,
    CrawlResponse,
    Form,
    FormField,
    Heading,
    Image,
    InteractiveElement,
    Link,
    Metadata,
    NavigationItem,
    Table,
)

# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

_CACHE_DIR = Path(__file__).parent / ".discovery-cache"


def _cache_key(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:16]


def _cache_get(url: str) -> Optional[CrawlResponse]:
    """Return cached CrawlResponse or None."""
    p = _CACHE_DIR / f"{_cache_key(url)}.json"
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return CrawlResponse(**data)
    except Exception:
        return None


def _cache_set(url: str, resp: CrawlResponse) -> None:
    """Persist a CrawlResponse to disk cache."""
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    p = _CACHE_DIR / f"{_cache_key(url)}.json"
    p.write_text(resp.model_dump_json(indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# HTML helpers
# ---------------------------------------------------------------------------

def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "html.parser")


def _text(el) -> str:
    return (el.get_text(strip=True) or "").strip()


def _attr(el, name: str, default: str = "") -> str:
    val = el.get(name, default)
    if val is None:
        return default
    # BeautifulSoup 4.12+ may return AttributeValueList for 'class' etc.
    if isinstance(val, (list, tuple)):
        return " ".join(str(v) for v in val)
    return str(val).strip()


def _abs_url(href: str, base: str) -> str:
    if not href or href.startswith(("javascript:", "#", "mailto:", "tel:")):
        return ""
    try:
        return urljoin(base, href)
    except Exception:
        return ""


def _is_external(url: str, base_origin: str) -> bool:
    try:
        parsed = urlparse(url)
        if not parsed.netloc:
            return False
        base_host = urlparse(base_origin).netloc or base_origin
        return parsed.netloc != base_host
    except Exception:
        return False


def _origin(url: str) -> str:
    """Return the origin (scheme + netloc) of a URL."""
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


# ---------------------------------------------------------------------------
# Extractors
# ---------------------------------------------------------------------------

def _extract_metadata(soup: BeautifulSoup, page_title: str) -> Metadata:
    meta = Metadata(title=page_title)
    for tag in soup.find_all("meta"):
        name = _attr(tag, "name").lower()
        prop = _attr(tag, "property").lower()
        content = _attr(tag, "content")
        if name == "description":
            meta.description = content
        elif name == "keywords":
            meta.keywords = content
        elif name == "author":
            meta.author = content
        elif name == "viewport":
            meta.viewport = content
        elif prop == "og:title":
            meta.og_title = content
        elif prop == "og:description":
            meta.og_description = content
        elif prop == "og:image":
            meta.og_image = content

    canonical = soup.find("link", rel="canonical")
    if canonical:
        meta.canonical = _attr(canonical, "href")

    favicon = soup.find("link", rel=lambda r: r and "icon" in r)
    if favicon:
        meta.favicon = _attr(favicon, "href")

    charset_tag = soup.find("meta", charset=True)
    if charset_tag:
        meta.charset = _attr(charset_tag, "charset")

    return meta


def _extract_headings(soup: BeautifulSoup) -> list[Heading]:
    headings = []
    for level in range(1, 7):
        for h in soup.find_all(f"h{level}"):
            headings.append(Heading(level=level, text=_text(h), id=_attr(h, "id")))
    return headings


def _extract_forms(soup: BeautifulSoup, base_url: str) -> list[Form]:
    forms = []
    for form_el in soup.find_all("form"):
        fields = []
        for inp in form_el.find_all(["input", "select", "textarea"]):
            tag = inp.name
            input_type = _attr(inp, "type", "text" if tag == "input" else "")
            name = _attr(inp, "name")
            placeholder = _attr(inp, "placeholder")
            required = inp.has_attr("required")
            value = _attr(inp, "value")
            field_id = _attr(inp, "id")
            aria_label = _attr(inp, "aria-label")

            # Try to find associated label
            label_text = ""
            if field_id:
                label = soup.find("label", attrs={"for": field_id})
                if label:
                    label_text = _text(label)
            if not label_text:
                parent_label = inp.find_parent("label")
                if parent_label:
                    label_text = _text(parent_label)

            options = []
            if tag == "select":
                for opt in inp.find_all("option"):
                    opt_text = _text(opt)
                    if opt_text:
                        options.append(opt_text)

            fields.append(
                FormField(
                    tag=tag,
                    input_type=input_type,
                    name=name,
                    placeholder=placeholder,
                    label=label_text,
                    required=required,
                    value=value,
                    options=options,
                    id=field_id,
                    aria_label=aria_label,
                )
            )

        forms.append(
            Form(
                action=_abs_url(_attr(form_el, "action"), base_url),
                method=_attr(form_el, "method", "GET").upper(),
                id=_attr(form_el, "id"),
                name=_attr(form_el, "name"),
                fields=fields,
                aria_label=_attr(form_el, "aria-label"),
            )
        )
    return forms


def _extract_links(soup: BeautifulSoup, base_url: str, base_origin: str) -> list[Link]:
    links = []
    seen = set()
    for a in soup.find_all("a", href=True):
        href = _abs_url(_attr(a, "href"), base_url)
        if not href or href in seen:
            continue
        seen.add(href)
        links.append(
            Link(
                text=_text(a),
                href=href,
                title=_attr(a, "title"),
                aria_label=_attr(a, "aria-label"),
                is_external=_is_external(href, base_origin),
            )
        )
    return links


def _extract_buttons(soup: BeautifulSoup) -> list[Button]:
    buttons = []
    for btn in soup.find_all(["button", "input"]):
        tag = btn.name
        if tag == "input":
            input_type = _attr(btn, "type", "submit")
            if input_type not in ("submit", "button", "reset"):
                continue

        btn_type = _attr(btn, "type", "button") if tag == "button" else _attr(btn, "type", "submit")
        text = _text(btn) if tag == "button" else _attr(btn, "value")

        buttons.append(
            Button(
                text=text,
                button_type=btn_type,
                aria_label=_attr(btn, "aria-label"),
                disabled=btn.has_attr("disabled"),
                id=_attr(btn, "id"),
                role=_attr(btn, "role", "button"),
            )
        )

    # Also capture elements with role="button"
    for el in soup.find_all(attrs={"role": "button"}):
        if el.name not in ("button", "input"):
            buttons.append(
                Button(
                    text=_text(el),
                    button_type="button",
                    aria_label=_attr(el, "aria-label"),
                    disabled=el.has_attr("aria-disabled"),
                    id=_attr(el, "id"),
                    role="button",
                )
            )
    return buttons


def _extract_navigation(soup: BeautifulSoup, base_url: str) -> list[NavigationItem]:
    """Extract navigation menus, including nested dropdowns."""

    def _parse_nav_element(el, depth: int = 0) -> list[NavigationItem]:
        items = []
        # Look for nested lists or direct links
        for li in el.find_all("li", recursive=False):
            a = li.find("a", href=True)
            if not a:
                continue

            children_el = li.find(["ul", "ol", "div"], class_=lambda c: c and ("dropdown" in str(c).lower() or "submenu" in str(c).lower() or "menu" in str(c).lower()))
            children = []
            is_dropdown = False
            if children_el:
                children = _parse_nav_element(children_el, depth + 1)
                is_dropdown = True

            items.append(
                NavigationItem(
                    text=_text(a),
                    href=_abs_url(_attr(a, "href"), base_url),
                    children=children,
                    is_dropdown=is_dropdown,
                    aria_label=_attr(a, "aria-label"),
                    role=_attr(a, "role", "link"),
                )
            )
        return items

    nav_items = []
    # Primary nav elements
    for nav in soup.find_all(["nav", "header"]):
        for ul in nav.find_all(["ul", "ol"], recursive=True):
            items = _parse_nav_element(ul)
            if items:
                nav_items.extend(items)
                break  # Only take the first significant list per nav

    # Fallback: look for common nav patterns
    if not nav_items:
        for el in soup.find_all(class_=lambda c: c and any(
            kw in str(c).lower() for kw in ("navbar", "nav-menu", "main-menu", "navigation")
        )):
            for a in el.find_all("a", href=True):
                nav_items.append(
                    NavigationItem(
                        text=_text(a),
                        href=_abs_url(_attr(a, "href"), base_url),
                        aria_label=_attr(a, "aria-label"),
                    )
                )

    return nav_items


def _extract_tables(soup: BeautifulSoup) -> list[Table]:
    tables = []
    for table_el in soup.find_all("table"):
        headers = []
        thead = table_el.find("thead")
        if thead:
            for th in thead.find_all("th"):
                headers.append(_text(th))

        rows = []
        tbody = table_el.find("tbody") or table_el
        for tr in tbody.find_all("tr"):
            cells = [_text(td) for td in tr.find_all(["td", "th"])]
            if cells:
                rows.append(cells)

        caption_el = table_el.find("caption")
        tables.append(
            Table(
                headers=headers,
                rows=rows,
                caption=_text(caption_el) if caption_el else "",
                aria_label=_attr(table_el, "aria-label"),
                id=_attr(table_el, "id"),
            )
        )
    return tables


def _extract_images(soup: BeautifulSoup, base_url: str) -> list[Image]:
    images = []
    for img in soup.find_all("img"):
        src = _abs_url(_attr(img, "src"), base_url)
        if not src:
            continue
        def _parse_dim(val: str) -> int:
            try:
                return int(val.rstrip("px").rstrip("em").rstrip("%"))
            except (ValueError, AttributeError):
                return 0
        images.append(
            Image(
                src=src,
                alt=_attr(img, "alt"),
                title=_attr(img, "title"),
                width=_parse_dim(_attr(img, "width", "0")),
                height=_parse_dim(_attr(img, "height", "0")),
            )
        )
    return images


# Class tokens that describe what an element IS are useful as a name source; layout and
# styling noise is not.
_CLASS_NOISE = re.compile(
    r"^(active|disabled|hidden|show|hide|open|closed|selected|first|last|odd|even|col|row"
    r"|container|wrapper|inner|outer|flex|grid|sm|md|lg|xl|d|p|m|mt|mb|ml|mr|px|py|text|bg"
    r"|border|rounded|shadow|w|h)([-_]?\d*)$",
    re.I,
)


def _humanise(raw: str) -> str:
    """'shopping-cart-link' / 'shopping_cart_container' / 'btnAddToCart' -> readable text."""
    s = re.sub(r"[-_.]+", " ", raw)
    s = re.sub(r"([a-z\d])([A-Z])", r"\1 \2", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def _stable_selector(tag) -> str:
    """A deterministic CSS selector for this element, most stable attribute first."""
    for attr in ("data-test", "data-testid", "data-qa"):
        val = _attr(tag, attr)
        if val:
            return f'[{attr}="{val}"]'
    el_id = _attr(tag, "id")
    return f"#{el_id}" if el_id else ""


def _derive_name(tag, base_url: str) -> str:
    """Readable name for an element with no accessible name, from stable attributes."""
    for attr in ("data-test", "data-testid", "data-qa", "id"):
        val = _attr(tag, attr)
        if val:
            return _humanise(val)
    for cls in (_attr(tag, "class")).split():
        if len(cls) > 2 and not _CLASS_NOISE.match(cls):
            return _humanise(cls)
    href = _attr(tag, "href")
    if href and not href.startswith("#") and not href.startswith("javascript:"):
        leaf = re.split(r"[?#]", href)[0].rstrip("/").split("/")[-1]
        leaf = re.sub(r"\.[a-z]{2,5}$", "", leaf, flags=re.I)
        if leaf:
            return _humanise(leaf)
    return ""


def _extract_interactive_elements(soup: BeautifulSoup, base_url: str) -> list[InteractiveElement]:
    """Extract all interactive elements with their selectors for Playwright."""
    elements = []
    seen = set()

    # Clickable elements
    for tag in soup.find_all(["a", "button", "input", "select", "textarea"]):
        role = _attr(tag, "role")
        if tag.name == "a":
            role = role or "link"
        elif tag.name == "button":
            role = role or "button"
        elif tag.name in ("input", "select", "textarea"):
            input_type = _attr(tag, "type", "text")
            role_map = {
                "checkbox": "checkbox",
                "radio": "radio",
                "submit": "button",
                "button": "button",
                "search": "searchbox",
            }
            role = role or role_map.get(input_type, "textbox")

        # Accessible name, in accname precedence order. The HTML `name` attribute is NOT
        # part of accessible-name computation and must come last: the pipeline resolves
        # these via Playwright's getByRole(role, {name}), which matches the accessible
        # name only. Preferring `name` emitted unlocatable elements — <input
        # name="user-name" placeholder="Username"> became "user-name" and every generated
        # locator missed. `value` covers <input type="submit" value="Login">.
        name = (
            _attr(tag, "aria-label")
            or _attr(tag, "placeholder")
            or _text(tag)
            or _attr(tag, "value")
            or _attr(tag, "title")
            or _attr(tag, "name")
        )
        # No accessible name at all — derive one from stable attributes instead of dropping
        # the element. Icon-only controls (cart, close, search, hamburger) have an empty
        # accessible name by construction: saucedemo's cart is
        # <a class="shopping_cart_link" data-test="shopping-cart-link" href="cart.html">
        # with a CSS background-image. `continue` here made every such control invisible to
        # the entire pipeline, and tests that needed one truncated.
        derived_name = False
        if not name:
            name = _derive_name(tag, base_url)
            if not name:
                continue
            derived_name = True

        # Dedupe on identity, not on name: with an empty name every unlabelled anchor
        # collapsed into a single "link:" entry.
        selector = _stable_selector(tag)
        key = selector or f"{role}:{name}:{len(elements)}"
        if key in seen:
            continue
        seen.add(key)

        css_classes = [c for c in (_attr(tag, "class")).split() if c]

        elements.append(
            InteractiveElement(
                tag=tag.name,
                role=role,
                name=name,
                text=_text(tag)[:100],
                href=_abs_url(_attr(tag, "href"), base_url) if tag.name == "a" else "",
                id=_attr(tag, "id"),
                css_classes=css_classes,
                test_id=(_attr(tag, "data-test") or _attr(tag, "data-testid")
                         or _attr(tag, "data-qa")),
                css=selector,
                derived_name=derived_name,
                aria_label=_attr(tag, "aria-label"),
                aria_role=_attr(tag, "role"),
                visible=True,
                enabled=not tag.has_attr("disabled"),
            )
        )

    # Elements with ARIA roles (menu items, tabs, etc.)
    for el in soup.find_all(attrs={"role": True}):
        role = _attr(el, "role")
        name = _attr(el, "aria-label") or _text(el)
        if not name or role in ("presentation", "none", "img"):
            continue
        key = f"{role}:{name}"
        if key in seen:
            continue
        seen.add(key)
        css_classes = [c for c in (_attr(el, "class")).split() if c]
        elements.append(
            InteractiveElement(
                tag=el.name,
                role=role,
                name=name,
                text=_text(el)[:100],
                id=_attr(el, "id"),
                css_classes=css_classes,
                aria_label=_attr(el, "aria-label"),
                aria_role=role,
                visible=True,
                enabled=not el.has_attr("aria-disabled"),
            )
        )

    return elements


def _extract_accessibility(soup: BeautifulSoup, images: list[Image], headings: list[Heading]) -> AccessibilityInfo:
    lang = _attr(soup.find("html"), "lang", "")
    title = _text(soup.find("title")) if soup.find("title") else ""

    landmark_roles = set()
    aria_landmarks = []
    for el in soup.find_all(attrs={"role": True}):
        role = _attr(el, "role")
        if role in ("banner", "navigation", "main", "contentinfo", "complementary", "search", "form", "region"):
            landmark_roles.add(role)
            aria_landmarks.append({"role": role, "label": _attr(el, "aria-label")})

    skip_links = []
    for a in soup.find_all("a"):
        href = _attr(a, "href", "")
        if href.startswith("#") and ("skip" in _text(a).lower() or "jump" in _text(a).lower()):
            skip_links.append(_text(a))

    images_with_alt = sum(1 for img in images if img.alt)
    heading_order = [h.level for h in headings]

    return AccessibilityInfo(
        lang=lang,
        title=title,
        landmark_roles=sorted(landmark_roles),
        aria_landmarks=aria_landmarks,
        skip_links=skip_links,
        images_with_alt=images_with_alt,
        images_total=len(images),
        heading_order=heading_order,
    )


def _detect_ui_patterns(soup: BeautifulSoup) -> dict:
    """Detect common UI patterns: modals, tabs, accordions, search, pagination."""
    has_modal = bool(
        soup.find(attrs={"role": "dialog"})
        or soup.find(class_=lambda c: c and "modal" in str(c).lower())
        or soup.find(id=lambda i: i and "modal" in str(i).lower())
    )
    has_tabs = bool(
        soup.find(attrs={"role": "tablist"})
        or soup.find(class_=lambda c: c and "tab" in str(c).lower())
    )
    has_accordion = bool(
        soup.find(class_=lambda c: c and any(kw in str(c).lower() for kw in ("accordion", "collapsible", "expandable")))
        or soup.find(attrs={"aria-expanded": True})
    )
    has_search = bool(
        soup.find(attrs={"role": "search"})
        or soup.find("input", attrs={"type": "search"})
        or soup.find(class_=lambda c: c and "search" in str(c).lower())
    )
    has_pagination = bool(
        soup.find(class_=lambda c: c and "pagination" in str(c).lower())
        or soup.find(attrs={"role": "navigation", "aria-label": lambda a: a and "pagination" in str(a).lower()})
    )
    return {
        "has_modal": has_modal,
        "has_tabs": has_tabs,
        "has_accordion": has_accordion,
        "has_search": has_search,
        "has_pagination": has_pagination,
    }


def _compute_dom_depth(soup: BeautifulSoup) -> int:
    """Compute maximum DOM depth."""
    max_depth = 0

    def _walk(el, depth):
        nonlocal max_depth
        if depth > max_depth:
            max_depth = depth
        for child in el.children:
            if hasattr(child, "name") and child.name:
                _walk(child, depth + 1)

    body = soup.find("body")
    if body:
        _walk(body, 0)
    return max_depth


def _needs_vision(soup: BeautifulSoup) -> tuple[bool, str]:
    """Determine if the page needs vision fallback."""
    # Canvas elements
    if soup.find("canvas"):
        return True, "Page contains canvas element"

    # Embed or object (PDF viewers, plugins)
    if soup.find(["embed", "object"]):
        return True, "Page contains embedded content"

    # Very few interactive elements but lots of images
    interactive = len(soup.find_all(["a", "button", "input", "select", "textarea"]))
    images = len(soup.find_all("img"))
    if interactive < 3 and images > 10:
        return True, "Image-heavy page with few interactive elements"

    # CAPTCHA detection
    captcha_indicators = ["captcha", "recaptcha", "hcaptcha"]
    page_text = soup.get_text().lower()
    if any(ind in page_text for ind in captcha_indicators):
        return True, "CAPTCHA detected"

    return False, ""


# ---------------------------------------------------------------------------
# Main crawl function
# ---------------------------------------------------------------------------

async def crawl(url: str, wait_after_load: int = 1000) -> CrawlResponse:
    """
    Crawl a single URL using Crawl4AI and extract structured DOM information.

    Falls back to httpx + BeautifulSoup if Crawl4AI is unavailable.
    """
    # Check cache first
    cached = _cache_get(url)
    if cached:
        return cached

    start_time = time.monotonic()
    response = CrawlResponse(url=url)

    try:
        html: str = ""
        status_code = 200

        # Try Crawl4AI first
        try:
            from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig

            browser_config = BrowserConfig(headless=True)
            run_config = CrawlerRunConfig(
                wait_until="domcontentloaded",
                page_timeout=30000,
            )
            async with AsyncWebCrawler(config=browser_config) as crawler:
                result = await crawler.arun(url=url, config=run_config)
                if result.success:
                    html = result.html or ""
                    status_code = result.status_code or 200
                    response.markdown = result.markdown or ""
                    response.cleaned_html = result.cleaned_html or html
                else:
                    raise Exception(f"Crawl4AI failed: {result.error_message}")
        except ImportError:
            # Fallback: use httpx + BeautifulSoup
            import httpx

            async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
                resp = await client.get(url)
                status_code = resp.status_code
                html = resp.text
                response.cleaned_html = html
        except Exception:
            # Fallback on any Crawl4AI error
            import httpx

            async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
                resp = await client.get(url)
                status_code = resp.status_code
                html = resp.text
                response.cleaned_html = html

        response.status_code = status_code

        if status_code >= 400:
            response.error = f"HTTP {status_code}"
            response.crawl_time_ms = int((time.monotonic() - start_time) * 1000)
            return response

        soup = _soup(html)
        base_origin = _origin(url)

        # Extract all structured information
        page_title = _text(soup.find("title")) if soup.find("title") else ""
        response.title = page_title
        response.metadata = _extract_metadata(soup, page_title)
        response.headings = _extract_headings(soup)
        response.forms = _extract_forms(soup, url)
        response.links = _extract_links(soup, url, base_origin)
        response.buttons = _extract_buttons(soup)
        response.navigation = _extract_navigation(soup, url)
        response.tables = _extract_tables(soup)
        response.images = _extract_images(soup, url)
        response.interactive_elements = _extract_interactive_elements(soup, url)

        # Classify URLs
        all_urls = set()
        for link in response.links:
            all_urls.add(link.href)
        for nav in response.navigation:
            if nav.href:
                all_urls.add(nav.href)

        for u in all_urls:
            if _is_external(u, base_origin):
                response.external_urls.append(u)
            else:
                response.internal_urls.append(u)

        # Detect UI patterns
        patterns = _detect_ui_patterns(soup)
        response.has_search = patterns["has_search"]
        response.has_pagination = patterns["has_pagination"]
        response.has_modal = patterns["has_modal"]
        response.has_tabs = patterns["has_tabs"]
        response.has_accordion = patterns["has_accordion"]

        # Breadcrumbs
        breadcrumb_el = soup.find(class_=lambda c: c and "breadcrumb" in str(c).lower())
        if breadcrumb_el:
            response.breadcrumbs = [_text(a) for a in breadcrumb_el.find_all("a")]

        # DOM depth
        response.dom_depth = _compute_dom_depth(soup)

        # Accessibility
        response.accessibility = _extract_accessibility(soup, response.images, response.headings)

        # Generate markdown if not already provided by Crawl4AI
        if not response.markdown:
            response.markdown = _html_to_markdown(soup)

        # Determine if vision is needed
        needs_vision, reason = _needs_vision(soup)
        response.needs_vision = needs_vision
        response.vision_reason = reason

        response.crawl_time_ms = int((time.monotonic() - start_time) * 1000)

        # Cache the result
        _cache_set(url, response)

        return response

    except Exception as e:
        response.error = str(e)
        response.crawl_time_ms = int((time.monotonic() - start_time) * 1000)
        return response


def _html_to_markdown(soup: BeautifulSoup) -> str:
    """Convert HTML to a simplified markdown representation."""
    lines = []
    body = soup.find("body")
    if not body:
        return ""

    def _walk(el, depth=0):
        if not hasattr(el, "name") or not el.name:
            text = str(el).strip()
            if text:
                lines.append(text)
            return

        tag = el.name.lower()
        if tag in ("script", "style", "noscript"):
            return

        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(tag[1])
            lines.append(f"\n{'#' * level} {_text(el)}\n")
            return
        if tag == "p":
            lines.append(f"\n{_text(el)}\n")
            return
        if tag == "a":
            href = _attr(el, "href")
            text = _text(el)
            if text and href:
                lines.append(f"[{text}]({href})")
            elif text:
                lines.append(text)
            return
        if tag == "img":
            alt = _attr(el, "alt", "image")
            src = _attr(el, "src")
            lines.append(f"![{alt}]({src})")
            return
        if tag in ("ul", "ol"):
            for i, li in enumerate(el.find_all("li", recursive=False)):
                prefix = f"{i+1}." if tag == "ol" else "-"
                lines.append(f"  {prefix} {_text(li)}")
            return
        if tag == "table":
            rows = el.find_all("tr")
            for row in rows:
                cells = [_text(c) for c in row.find_all(["th", "td"])]
                if cells:
                    lines.append("| " + " | ".join(cells) + " |")
            lines.append("")
            return
        if tag == "br":
            lines.append("")
            return
        if tag == "hr":
            lines.append("---")
            return

        for child in el.children:
            _walk(child, depth + 1)

    _walk(body)
    return "\n".join(lines).strip()
