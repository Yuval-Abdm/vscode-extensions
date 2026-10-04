<?php
/** Outils d'affichage. */
class Helper extends BaseHelper
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
