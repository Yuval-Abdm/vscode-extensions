<?php
/** Outils d'affichage. */
class Helper extends BaseHelper implements Renderer
{
    public function render(string $text): string
    {
        return $this->escape($text);
    }
}

abstract class BaseHelper
{
    protected function escape(string $text): string
    {
        return htmlspecialchars($text);
    }
}

interface Renderer
{
    public function render(string $text): string;
}
