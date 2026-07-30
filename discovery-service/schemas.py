"""Pydantic schemas for the Discovery Service API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class CrawlRequest(BaseModel):
    """Request to crawl a single page."""

    url: str = Field(..., description="URL to crawl")
    wait_after_load: int = Field(
        default=1000,
        description="Milliseconds to wait after page load before extracting",
    )


class FormField(BaseModel):
    """A single input/select/textarea inside a form."""

    tag: str = Field(..., description="HTML tag name: input, select, textarea")
    input_type: str = Field(default="text", description="Input type attribute")
    name: str = Field(default="", description="Name attribute")
    placeholder: str = Field(default="", description="Placeholder text")
    label: str = Field(default="", description="Associated label text")
    required: bool = Field(default=False)
    value: str = Field(default="", description="Current value")
    options: list[str] = Field(default_factory=list, description="Options for select elements")
    id: str = Field(default="", description="Element id")
    aria_label: str = Field(default="", description="ARIA label")


class Form(BaseModel):
    """An HTML form with its fields."""

    action: str = Field(default="", description="Form action URL")
    method: str = Field(default="GET", description="HTTP method")
    id: str = Field(default="", description="Form id")
    name: str = Field(default="", description="Form name")
    fields: list[FormField] = Field(default_factory=list)
    aria_label: str = Field(default="")


class NavigationItem(BaseModel):
    """A single navigation link or menu item."""

    text: str
    href: str = ""
    children: list[NavigationItem] = Field(default_factory=list)
    is_dropdown: bool = False
    aria_label: str = ""
    role: str = "link"


class Link(BaseModel):
    """An anchor tag."""

    text: str
    href: str
    title: str = ""
    aria_label: str = ""
    is_external: bool = False
    role: str = "link"


class Button(BaseModel):
    """A button or button-like element."""

    text: str
    button_type: str = Field(default="button", description="button, submit, reset")
    aria_label: str = ""
    disabled: bool = False
    id: str = ""
    role: str = "button"


class Heading(BaseModel):
    """A heading element (h1-h6)."""

    level: int
    text: str
    id: str = ""


class Table(BaseModel):
    """An HTML table."""

    headers: list[str] = Field(default_factory=list)
    rows: list[list[str]] = Field(default_factory=list)
    caption: str = ""
    aria_label: str = ""
    id: str = ""


class Image(BaseModel):
    """An img element."""

    src: str
    alt: str = ""
    title: str = ""
    width: int = 0
    height: int = 0


class InteractiveElement(BaseModel):
    """Any clickable or interactive element discovered in the DOM."""

    tag: str
    role: str = ""
    name: str = ""
    text: str = ""
    href: str = ""
    id: str = ""
    css_classes: list[str] = Field(default_factory=list)
    xpath: str = ""
    aria_label: str = ""
    aria_role: str = ""
    visible: bool = True
    enabled: bool = True
    # data-test / data-testid / data-qa value, when present.
    test_id: str = ""
    # Deterministic CSS selector for this exact element. The only way to reach a control
    # whose accessible name is empty (icon-only cart, close, search).
    css: str = ""
    # True when `name` was derived from attributes rather than read from an accname source.
    derived_name: bool = False


class Metadata(BaseModel):
    """Page metadata from meta tags and document properties."""

    title: str = ""
    description: str = ""
    keywords: str = ""
    author: str = ""
    og_title: str = ""
    og_description: str = ""
    og_image: str = ""
    canonical: str = ""
    charset: str = ""
    viewport: str = ""
    favicon: str = ""


class AccessibilityInfo(BaseModel):
    """Accessibility information extracted from the page."""

    lang: str = ""
    title: str = ""
    landmark_roles: list[str] = Field(default_factory=list)
    aria_landmarks: list[dict] = Field(default_factory=list)
    skip_links: list[str] = Field(default_factory=list)
    forms_with_labels: int = 0
    images_with_alt: int = 0
    images_total: int = 0
    heading_order: list[int] = Field(default_factory=list)


class CrawlResponse(BaseModel):
    """Full structured response from crawling a page."""

    url: str
    title: str = ""
    status_code: int = 200
    metadata: Metadata = Field(default_factory=Metadata)
    markdown: str = ""
    cleaned_html: str = ""
    forms: list[Form] = Field(default_factory=list)
    navigation: list[NavigationItem] = Field(default_factory=list)
    links: list[Link] = Field(default_factory=list)
    buttons: list[Button] = Field(default_factory=list)
    headings: list[Heading] = Field(default_factory=list)
    tables: list[Table] = Field(default_factory=list)
    images: list[Image] = Field(default_factory=list)
    interactive_elements: list[InteractiveElement] = Field(default_factory=list)
    internal_urls: list[str] = Field(default_factory=list)
    external_urls: list[str] = Field(default_factory=list)
    breadcrumbs: list[str] = Field(default_factory=list)
    has_search: bool = False
    has_pagination: bool = False
    has_modal: bool = False
    has_tabs: bool = False
    has_accordion: bool = False
    dom_depth: int = 0
    accessibility: AccessibilityInfo = Field(default_factory=AccessibilityInfo)
    needs_vision: bool = Field(
        default=False,
        description="True if the page contains elements that cannot be understood from DOM alone (canvas, captcha, image-based menus)",
    )
    vision_reason: str = ""
    crawl_time_ms: int = 0
    error: str = ""
