import sys
sys.path.insert(0, r"C:\Users\Gunwant Singh Hada\Downloads\test-AI-integration\test-AI-integration\discovery-service")
from crawler import _soup, _extract_headings, _extract_links, _extract_forms, _extract_buttons, _extract_interactive_elements, _extract_navigation, _extract_metadata
import httpx
import asyncio

async def test():
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        resp = await client.get("https://example.com")
        html = resp.text
        print(f"HTML length: {len(html)}")
        
        soup = _soup(html)
        title = soup.find("title")
        print(f"Title tag: {title}")
        print(f"Title text: {title.get_text() if title else 'NONE'}")
        
        headings = _extract_headings(soup)
        print(f"Headings: {len(headings)} -> {[(h.level, h.text) for h in headings]}")
        
        links = _extract_links(soup, "https://example.com", "example.com")
        print(f"Links: {len(links)} -> {[(l.text, l.href) for l in links]}")
        
        forms = _extract_forms(soup, "https://example.com")
        print(f"Forms: {len(forms)}")
        
        buttons = _extract_buttons(soup)
        print(f"Buttons: {len(buttons)}")
        
        nav = _extract_navigation(soup, "https://example.com")
        print(f"Navigation: {len(nav)}")
        
        interactive = _extract_interactive_elements(soup, "https://example.com")
        print(f"Interactive: {len(interactive)} -> {[(ie.tag, ie.role, ie.name) for ie in interactive]}")
        
        metadata = _extract_metadata(soup, "Example")
        print(f"Metadata title: {metadata.title}")
        print(f"Metadata description: {metadata.description}")

asyncio.run(test())
