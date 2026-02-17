// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { Lightbox } from "./Lightbox.js";

describe("Lightbox", () => {
  const defaultProps = {
    src: "data:image/png;base64,abc123",
    alt: "test image",
    onClose: vi.fn(),
  };

  beforeEach(() => {
    defaultProps.onClose = vi.fn();
  });

  it("renders a full-size image in a modal overlay", () => {
    render(<Lightbox {...defaultProps} />);

    // The lightbox should be rendered (via portal on document.body)
    const backdrop = screen.getByTestId("lightbox-backdrop");
    expect(backdrop).toBeTruthy();

    // The image should be present with the correct src
    const img = screen.getByTestId("lightbox-image");
    expect(img.getAttribute("src")).toBe(defaultProps.src);
    expect(img.getAttribute("alt")).toBe(defaultProps.alt);
  });

  it("calls onClose when clicking the backdrop", () => {
    render(<Lightbox {...defaultProps} />);

    const backdrop = screen.getByTestId("lightbox-backdrop");
    fireEvent.click(backdrop);

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking the image itself", () => {
    render(<Lightbox {...defaultProps} />);

    const img = screen.getByTestId("lightbox-image");
    fireEvent.click(img);

    // Clicking the image should NOT close the lightbox (stopPropagation)
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when pressing Escape", () => {
    render(<Lightbox {...defaultProps} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when pressing other keys", () => {
    render(<Lightbox {...defaultProps} />);

    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "a" });

    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when clicking the close button", () => {
    render(<Lightbox {...defaultProps} />);

    const closeBtn = screen.getByTestId("lightbox-close");
    fireEvent.click(closeBtn);

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("uses default alt text when none is provided", () => {
    render(<Lightbox src={defaultProps.src} onClose={defaultProps.onClose} />);

    const img = screen.getByTestId("lightbox-image");
    expect(img.getAttribute("alt")).toBe("Full-size image");
  });

  it("prevents body scroll while open", () => {
    const { unmount } = render(<Lightbox {...defaultProps} />);

    // Body overflow should be set to hidden
    expect(document.body.style.overflow).toBe("hidden");

    // After unmount, overflow should be restored
    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});
