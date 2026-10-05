<?php
class User
{
    public $name;

    public function __construct($name)
    {
        $this->name = $name;
        $this->created = time();
    }

    public function greet()
    {
        return 'Hello ' . $this->name . $this->created;
    }
}
