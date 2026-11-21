/** `widget.js`: the embeddable loader (docs/decisions/feedback.md FB-03). One IIFE, one global. */
import { install } from './loader';

install(window);
